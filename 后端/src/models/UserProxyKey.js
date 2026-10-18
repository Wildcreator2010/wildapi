const { pool } = require('../config/database');
const crypto = require('crypto');

const MAX_KEYS_PER_USER = 20;

/**
 * 用户代理分发密钥
 * 系统生成 ak- 前缀 secret，明文仅在创建时返回一次；
 * 数据库仅存 sha256 哈希，无法二次查看明文
 */
class UserProxyKey {
  static generateSecret() {
    return 'ak-' + crypto.randomBytes(24).toString('hex');
  }

  static hash(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  static mask(prefix, suffix) {
    return `${prefix}****${suffix}`;
  }

  static async countByUser(userId) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) as total FROM user_proxy_keys WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    return rows[0].total;
  }

  static async create({ userId, name }, conn = null) {
    const secret = this.generateSecret();
    const keyHash = this.hash(secret);
    const keyPrefix = secret.substring(0, 11);   // 'ak-' + 8 位
    const keySuffix = secret.substring(secret.length - 4);

    // 支持传入事务连接 (配额检查与插入同事务，防并发超限)
    const executor = conn || pool;
    const [result] = await executor.query(
      'INSERT INTO user_proxy_keys (user_id, name, key_prefix, key_hash, key_suffix) VALUES (?, ?, ?, ?, ?)',
      [userId, name || null, keyPrefix, keyHash, keySuffix]
    );

    return {
      id: result.insertId,
      name: name || null,
      secret, // 唯一一次明文
      masked: this.mask(keyPrefix, keySuffix),
      keyPrefix,
      keySuffix,
      createdAt: new Date(),
    };
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM user_proxy_keys WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async listByUser(userId) {
    const [rows] = await pool.query(
      `SELECT id, name, key_prefix, key_suffix, is_active, last_used_at, created_at, updated_at
       FROM user_proxy_keys WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map(r => ({
      ...r,
      masked: this.mask(r.key_prefix, r.key_suffix),
    }));
  }

  static async findByHash(keyHash) {
    const [rows] = await pool.query(
      `SELECT upk.*, u.username, u.role, u.balance, u.is_active as user_active, u.rpm_limit
       FROM user_proxy_keys upk JOIN users u ON upk.user_id = u.id
       WHERE upk.key_hash = ? AND upk.is_active = 1 AND u.is_active = 1`,
      [keyHash]
    );
    return rows[0] || null;
  }

  static async touchLastUsed(id) {
    await pool.query('UPDATE user_proxy_keys SET last_used_at = NOW() WHERE id = ?', [id]);
  }

  // 写操作只在 (id, user_id) 同时命中时生效; 回读也必须带同一条件，
  // 否则改到别人的密钥 id 会返回对方整行数据 (含 key_hash) 并报 200
  static async findByIdForUser(id, userId) {
    const [rows] = await pool.query(
      'SELECT id, name, key_prefix, key_suffix, is_active, last_used_at, created_at, updated_at FROM user_proxy_keys WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    return rows[0] ? { ...rows[0], masked: this.mask(rows[0].key_prefix, rows[0].key_suffix) } : null;
  }

  static async rename(id, userId, name) {
    await pool.query(
      'UPDATE user_proxy_keys SET name = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [name || null, id, userId]
    );
    return this.findByIdForUser(id, userId);
  }

  static async toggleActive(id, userId) {
    await pool.query(
      'UPDATE user_proxy_keys SET is_active = NOT is_active, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    return this.findByIdForUser(id, userId);
  }

  static async delete(id, userId) {
    const [result] = await pool.query(
      'DELETE FROM user_proxy_keys WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    return result.affectedRows > 0;
  }
}

UserProxyKey.MAX_KEYS_PER_USER = MAX_KEYS_PER_USER;

module.exports = UserProxyKey;
