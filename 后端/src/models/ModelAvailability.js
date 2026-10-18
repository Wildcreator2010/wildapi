const { pool, redis } = require('../config/database');
const logger = require('../utils/logger');

/**
 * 上游模型可用性 (model_availability 表，由 availabilityService 周期 upsert)
 * 提供"从上游继承"的模型列表数据源，供 /v1/models 与 /api/user/models 使用
 */

const CACHE_KEY = 'models:upstream:available';
const CACHE_TTL_SEC = 30; // 短缓存: 降低高频调用下的 DB 压力，同时保证上游变更较快可见

class ModelAvailability {
  /**
   * 查询上游检测为可用的模型 (去重 + 排序)
   * 排除 '__key__' 密钥级占位记录；同一模型被多把密钥检测时只保留一条，
   * 延迟取最优 (最小) 值
   * @returns {Promise<Array<{model, providerName, providerType, latencyMs, source: 'upstream'}>>}
   */
  static async listAvailable() {
    // 1. 短缓存 (Redis 不可用时直接查库)
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {
      // 降级直查
    }

    const [rows] = await pool.query(
      `SELECT ma.model, MIN(ma.latency_ms) AS latency_ms,
              p.name AS provider_name, p.type AS provider_type
       FROM model_availability ma
       LEFT JOIN providers p ON ma.provider_id = p.id
       WHERE ma.status = 'available' AND ma.model <> '__key__'
       GROUP BY ma.model, p.name, p.type
       ORDER BY p.name ASC, ma.model ASC`
    );

    // 2. 跨服务商去重 (同名模型保留首个, 按服务商名排序后稳定)
    const seen = new Set();
    const list = [];
    for (const r of rows) {
      if (seen.has(r.model)) continue;
      seen.add(r.model);
      list.push({
        model: r.model,
        providerName: r.provider_name || '默认服务商',
        providerType: r.provider_type || 'openai',
        latencyMs: r.latency_ms,
        source: 'upstream',
      });
    }

    // 3. 写缓存 (失败不影响返回)
    try {
      await redis.set(CACHE_KEY, JSON.stringify(list), 'EX', CACHE_TTL_SEC);
    } catch {
      // 忽略缓存写入失败
    }

    return list;
  }

  /**
   * 安全获取上游可用模型: 任何异常 (表不存在/DB 不可用) 返回空数组，
   * 由调用方回退本地已上架模型，保证模型列表接口不失败
   */
  static async listAvailableSafe() {
    try {
      return await this.listAvailable();
    } catch (err) {
      logger.warn('上游可用模型查询失败，回退本地模型列表', { error: err.message });
      return [];
    }
  }
}

module.exports = ModelAvailability;
