const { pool } = require('../config/database');

/**
 * 供应商分类 (厂商类型) 动态化管理
 * providers.type / pricing_configs.provider_type 存 code 字符串
 */
class ProviderType {
  static async list({ activeOnly = false } = {}) {
    const sql = activeOnly
      ? 'SELECT * FROM provider_types WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
      : 'SELECT * FROM provider_types ORDER BY sort_order ASC, id ASC';
    const [rows] = await pool.query(sql);
    return rows;
  }

  static async listActiveCodes() {
    const rows = await this.list({ activeOnly: true });
    return rows.map(r => r.code);
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM provider_types WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async findByCode(code) {
    const [rows] = await pool.query('SELECT * FROM provider_types WHERE code = ?', [code]);
    return rows[0] || null;
  }

  static async create({ code, label, sortOrder = 0 }) {
    const [result] = await pool.query(
      'INSERT INTO provider_types (code, label, sort_order) VALUES (?, ?, ?)',
      [code, label, sortOrder]
    );
    return this.findById(result.insertId);
  }

  static async update(id, fields) {
    const allowed = ['code', 'label', 'sort_order', 'is_active'];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k) && v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    await pool.query(`UPDATE provider_types SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  /**
   * 删除分类前检查引用: 有服务商/定价使用该分类时禁止删除 (防止数据悬空)
   * @returns {{ ok: boolean, providerCount: number, pricingCount: number }}
   */
  static async countReferences(code) {
    const [providers] = await pool.query('SELECT COUNT(*) AS n FROM providers WHERE type = ?', [code]);
    const [pricings] = await pool.query('SELECT COUNT(*) AS n FROM pricing_configs WHERE provider_type = ?', [code]);
    return { providerCount: providers[0].n, pricingCount: pricings[0].n };
  }

  static async delete(id) {
    await pool.query('DELETE FROM provider_types WHERE id = ?', [id]);
  }
}

module.exports = ProviderType;
