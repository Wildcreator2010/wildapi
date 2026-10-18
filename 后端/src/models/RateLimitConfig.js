const { pool } = require('../config/database');
const { ValidationError } = require('../utils/errors');

class RateLimitConfig {
  static async findByProviderId(providerId) {
    const [rows] = await pool.query('SELECT * FROM rate_limit_configs WHERE provider_id = ?', [providerId]);
    return rows[0] || null;
  }

  static async upsert(providerId, { requestsPerMinute, concurrentLimit, retryAttempts, retryDelayMs } = {}) {
    // 数值字段严格校验，防字符串/NaN 写入数值列 (报 400 让管理员看到原因，而不是笼统 500)
    const sanitize = (v) => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ValidationError('限流配置必须为非负数字');
      return n;
    };
    const rpm = sanitize(requestsPerMinute);
    const conc = sanitize(concurrentLimit);
    const retry = sanitize(retryAttempts);
    const delay = sanitize(retryDelayMs);

    // 单条语句原子完成，避免先查后插的并发唯一键冲突；
    // 未提供字段: 新行用默认值，已有行保留原值 (COALESCE)
    await pool.query(
      `INSERT INTO rate_limit_configs (provider_id, requests_per_minute, concurrent_limit, retry_attempts, retry_delay_ms)
       VALUES (?, COALESCE(?, 60), COALESCE(?, 10), COALESCE(?, 3), COALESCE(?, 1000))
       ON DUPLICATE KEY UPDATE
         requests_per_minute = COALESCE(?, requests_per_minute),
         concurrent_limit = COALESCE(?, concurrent_limit),
         retry_attempts = COALESCE(?, retry_attempts),
         retry_delay_ms = COALESCE(?, retry_delay_ms)`,
      [providerId, rpm, conc, retry, delay, rpm, conc, retry, delay]
    );
    return this.findByProviderId(providerId);
  }
}

module.exports = RateLimitConfig;
