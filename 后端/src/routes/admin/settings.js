const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { pool, redis } = require('../../config/database');
const { config } = require('../../config');
const { DEFAULT_PRICING } = require('../../services/billingService');
const { ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// 获取系统设置
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [settings] = await pool.query('SELECT * FROM system_settings');
    const settingsMap = {};
    for (const s of settings) {
      settingsMap[s.setting_key] = s.setting_value;
    }

    // 合并默认值和数据库值
    res.json({
      success: true,
      data: {
        settings: {
          globalRateLimit: settingsMap.global_rate_limit || String(config.globalRateLimit),
          defaultRetryAttempts: settingsMap.default_retry_attempts || '3',
          defaultRetryDelayMs: settingsMap.default_retry_delay_ms || '1000',
          requestBodyMaxSizeMb: settingsMap.request_body_max_size_mb || '10',
        },
        pricing: DEFAULT_PRICING,
        redisInfo: {
          host: config.redis.host,
          port: config.redis.port,
        },
      },
    });
  } catch (err) { next(err); }
});

// 更新系统设置 (数值型设置严格校验，防非数字字符串入库后下游 parseInt 得 NaN 静默降级)
router.put('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    // key -> { max } 白名单与合理上限; 注意: request_body_max_size_mb 当前仅供展示，
    // 实际 body 上限在 app.js 硬编码，修改本项不会生效，后续接入时需消费该配置。
    const allowedKeys = {
      global_rate_limit: { max: 100000 },
      default_retry_attempts: { max: 10 },
      default_retry_delay_ms: { max: 60000 },
      request_body_max_size_mb: { max: 100 },
    };
    const updates = [];

    for (const [key, value] of Object.entries(req.body)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      const rule = allowedKeys[dbKey];
      if (!rule || value === undefined) continue;

      // input 值恒为字符串，用 Number 校验即可 (拒绝 NaN/Infinity/范围外)
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > rule.max) {
        throw new ValidationError(`设置项 ${key} 必须为 1-${rule.max} 之间的数字`);
      }

      await pool.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [dbKey, String(n), String(n)]
      );
      updates.push({ key: dbKey, value: String(n) });
    }

    logger.info('系统设置已更新', { adminId: req.user.id, updates });

    res.json({ success: true, message: '设置已更新', data: { updated: updates } });
  } catch (err) { next(err); }
});

module.exports = router;
