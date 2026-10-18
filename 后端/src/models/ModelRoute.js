const { pool } = require('../config/database');

class ModelRoute {
  static async create({ modelPattern, providerId, priority = 0 }) {
    const [result] = await pool.query(
      'INSERT INTO model_routes (model_pattern, provider_id, priority) VALUES (?, ?, ?)',
      [modelPattern, providerId, priority]
    );
    return this.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM model_routes WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async list() {
    const [rows] = await pool.query(
      `SELECT mr.*, p.name as provider_name, p.type as provider_type 
       FROM model_routes mr LEFT JOIN providers p ON mr.provider_id = p.id 
       WHERE mr.is_active = 1 AND p.is_active = 1 ORDER BY mr.priority ASC, mr.id ASC`
    );
    return rows;
  }

  static async listByProvider(providerId) {
    const [rows] = await pool.query(
      'SELECT * FROM model_routes WHERE provider_id = ? ORDER BY priority ASC',
      [providerId]
    );
    return rows;
  }

  /**
   * 判断模型是否匹配路由模式 (支持通配符: gpt-4* 匹配 gpt-4o 等)
   */
  static matchesPattern(pattern, model) {
    if (!pattern || !model) return false;
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
      return regex.test(model);
    }
    return pattern.toLowerCase() === model.toLowerCase();
  }

  /**
   * 模式精确度分级: 精确名 > 前缀通配 (gpt-4*) > 全通配 (*)。
   * 同级内再按 priority/id 决定，避免一条 `*` 兜底路由把已下架的精确路由盖过去。
   */
  static specificity(pattern) {
    if (!pattern) return -1;
    if (!pattern.includes('*')) return 3;
    if (pattern === '*') return 1;
    return 2;
  }

  /**
   * 在按 priority ASC, id ASC 取回的路由中挑选最具体的一条
   */
  static pickMostSpecific(rows, model) {
    let best = null;
    let bestScore = -1;
    for (const route of rows) {
      if (!this.matchesPattern(route.model_pattern, model)) continue;
      const score = this.specificity(route.model_pattern);
      if (score > bestScore) {
        best = route;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * 匹配模型路由 (包含已下架的路由，用于模型上下架检查)
   * 返回 null 表示无匹配；返回 route 对象含 is_active 状态
   */
  static async matchModelIncludingInactive(model) {
    const [rows] = await pool.query(
      `SELECT mr.*, p.name as provider_name, p.type as provider_type
       FROM model_routes mr LEFT JOIN providers p ON mr.provider_id = p.id
       ORDER BY mr.priority ASC, mr.id ASC`
    );
    return this.pickMostSpecific(rows, model);
  }

  /**
   * 根据模型名称匹配路由
   * 支持通配符: gpt-4* 匹配 gpt-4, gpt-4-turbo, gpt-4o 等
   */
  static async matchModel(model) {
    const activeRoutes = await this.list();
    const matched = this.pickMostSpecific(activeRoutes, model);
    if (matched) return matched;
    // 未匹配到特定路由，返回第一个活跃的 provider
    const Provider = require('./Provider');
    const providers = await Provider.listActive();
    if (providers.length === 0) return null;
    return {
      provider_id: providers[0].id,
      provider_name: providers[0].name,
      provider_type: providers[0].type,
      model_pattern: '*',
    };
  }

  static async update(id, fields) {
    const allowed = ['model_pattern', 'provider_id', 'priority', 'is_active'];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    await pool.query(`UPDATE model_routes SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id) {
    await pool.query('DELETE FROM model_routes WHERE id = ?', [id]);
  }
}

module.exports = ModelRoute;
