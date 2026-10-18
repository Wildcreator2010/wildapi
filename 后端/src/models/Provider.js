const { pool } = require('../config/database');

class Provider {
  static async create({ name, type, baseUrl, weight = 1 }) {
    const [result] = await pool.query(
      'INSERT INTO providers (name, type, base_url, weight) VALUES (?, ?, ?, ?)',
      [name, type, baseUrl, weight]
    );
    return this.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM providers WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async list() {
    const [rows] = await pool.query('SELECT * FROM providers ORDER BY created_at DESC');
    return rows;
  }

  static async listActive() {
    const [rows] = await pool.query('SELECT * FROM providers WHERE is_active = 1 ORDER BY weight DESC');
    return rows;
  }

  static async update(id, fields) {
    const allowed = ['name', 'type', 'base_url', 'weight', 'is_active'];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    await pool.query(`UPDATE providers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id) {
    await pool.query('DELETE FROM providers WHERE id = ?', [id]);
  }
}

module.exports = Provider;
