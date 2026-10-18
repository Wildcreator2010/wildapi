const { pool } = require('../config/database');
const { encrypt, decrypt } = require('../services/encryptionService');
const { ValidationError } = require('../utils/errors');

class ProviderKey {
  static async create({ providerId, keyName, rawKey }) {
    // trim 防止粘贴带入空格/换行导致上游鉴权失败
    const cleanKey = String(rawKey || '').trim();
    if (!cleanKey) throw new ValidationError('密钥不能为空');
    const keyEncrypted = encrypt(cleanKey);
    const [result] = await pool.query(
      'INSERT INTO provider_keys (provider_id, key_name, key_encrypted) VALUES (?, ?, ?)',
      [providerId, keyName || null, keyEncrypted]
    );
    return this.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM provider_keys WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async listByProvider(providerId) {
    const [rows] = await pool.query(
      'SELECT id, provider_id, key_name, is_active, usage_count, last_used_at, cooldown_until, created_at FROM provider_keys WHERE provider_id = ? ORDER BY usage_count ASC',
      [providerId]
    );
    return rows;
  }

  /**
   * 获取可用的密钥列表 (已排序: 用量最少 + 未冷却 + 活跃)
   */
  static async getAvailableKeys(providerId) {
    const [rows] = await pool.query(
      `SELECT * FROM provider_keys 
       WHERE provider_id = ? AND is_active = 1 
       AND (cooldown_until IS NULL OR cooldown_until < NOW())
       ORDER BY usage_count ASC, last_used_at ASC`,
      [providerId]
    );
    return rows;
  }

  static async getDecryptedKey(id) {
    const key = await this.findById(id);
    if (!key) return null;
    return decrypt(key.key_encrypted);
  }

  static async incrementUsage(id) {
    await pool.query(
      'UPDATE provider_keys SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?',
      [id]
    );
  }

  static async setCooldown(id, cooldownSeconds = 60) {
    await pool.query(
      'UPDATE provider_keys SET cooldown_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?',
      [cooldownSeconds, id]
    );
  }

  static async toggleActive(id) {
    await pool.query('UPDATE provider_keys SET is_active = NOT is_active WHERE id = ?', [id]);
    return this.findById(id);
  }

  static async delete(id) {
    await pool.query('DELETE FROM provider_keys WHERE id = ?', [id]);
  }
}

module.exports = ProviderKey;
