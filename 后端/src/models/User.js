const { pool } = require('../config/database');

class User {
  static async findByWildAccountId(wildaccountId) {
    const [rows] = await pool.query('SELECT * FROM users WHERE wildaccount_id = ?', [wildaccountId]);
    return rows[0] || null;
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async upsert({ wildaccountId, username, email, role }) {
    // 单条原子 UPSERT，避免并发首次 SSO 登录时 wildaccount_id UNIQUE 冲突。
    // role 仅在首次插入时写入 (新用户默认 'user')，后续登录不覆盖:
    // 角色变更只走本地管理接口，防止上游响应恢复已撤销的权限或提权。
    await pool.query(
      `INSERT INTO users (wildaccount_id, username, email, role) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE username = VALUES(username), email = VALUES(email),
         updated_at = NOW()`,
      [wildaccountId, username, email, role]
    );
    return this.findByWildAccountId(wildaccountId);
  }

  static async list({ page = 1, pageSize = 20, search = '', role = '', isActive = null }) {
    const conditions = [];
    const params = [];
    if (search) {
      conditions.push('(username LIKE ? OR email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (role) { conditions.push('role = ?'); params.push(role); }
    if (isActive !== null) { conditions.push('is_active = ?'); params.push(isActive); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * pageSize;

    const [countResult] = await pool.query(`SELECT COUNT(*) as total FROM users ${where}`, params);
    const [rows] = await pool.query(
      `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    return { list: rows, total: countResult[0].total, page, pageSize };
  }

  static async updateBalance(id, amount) {
    await pool.query(
      'UPDATE users SET balance = balance + ?, updated_at = NOW() WHERE id = ?',
      [amount, id]
    );
    return this.findById(id);
  }

  static async setActive(id, isActive) {
    await pool.query('UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?', [isActive ? 1 : 0, id]);
    return this.findById(id);
  }

  static async checkBalance(id, requiredAmount) {
    const user = await this.findById(id);
    if (!user) throw new Error('用户不存在');
    return parseFloat(user.balance) >= requiredAmount;
  }
}

module.exports = User;
