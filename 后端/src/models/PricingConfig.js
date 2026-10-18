const { pool } = require('../config/database');

/**
 * 模型动态定价配置
 * 按模型匹配模式 + 厂商类型区分，代理扣费时实时查询生效
 */
class PricingConfig {
  static async create({ modelPattern, providerType = 'openai', promptPrice, completionPrice, multiplier = 1 }) {
    const [result] = await pool.query(
      'INSERT INTO pricing_configs (model_pattern, provider_type, prompt_price, completion_price, multiplier) VALUES (?, ?, ?, ?, ?)',
      [modelPattern, providerType, promptPrice, completionPrice, multiplier]
    );
    return this.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM pricing_configs WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async list() {
    const [rows] = await pool.query(
      'SELECT * FROM pricing_configs ORDER BY provider_type ASC, model_pattern ASC'
    );
    return rows;
  }

  static async listActive() {
    const [rows] = await pool.query(
      'SELECT * FROM pricing_configs WHERE is_active = 1 ORDER BY model_pattern ASC'
    );
    return rows;
  }

  /**
   * 查找与模型+厂商匹配的有效定价
   * 优先精确匹配，其次前缀通配 (如 gpt-4* 匹配 gpt-4-turbo)
   */
  static async findMatch(model, providerType = 'openai') {
    const active = await this.listActive();
    // 按厂商过滤优先，跨厂商兜底
    const sameVendor = active.filter(p => p.provider_type === providerType);
    const others = active.filter(p => p.provider_type !== providerType);

    for (const candidate of [...sameVendor, ...others]) {
      const pattern = candidate.model_pattern;
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
        if (regex.test(model)) return candidate;
      } else if (pattern.toLowerCase() === model.toLowerCase()) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * 前端 PUT 发 camelCase 字段，白名单为 DB snake_case 列名，
   * 需先做别名映射，否则全部字段被过滤、更新静默失效 (200 但没改)
   */
  static async update(id, fields) {
    const aliases = {
      modelPattern: 'model_pattern',
      providerType: 'provider_type',
      promptPrice: 'prompt_price',
      completionPrice: 'completion_price',
    };
    const allowed = ['model_pattern', 'provider_type', 'prompt_price', 'completion_price', 'multiplier', 'is_active'];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = aliases[k] || k;
      if (allowed.includes(col) && v !== undefined) { sets.push(`${col} = ?`); params.push(v); }
    }
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    await pool.query(`UPDATE pricing_configs SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id) {
    await pool.query('DELETE FROM pricing_configs WHERE id = ?', [id]);
  }
}

module.exports = PricingConfig;
