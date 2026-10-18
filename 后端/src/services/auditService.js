const { pool } = require('../config/database');
const logger = require('../utils/logger');

/** 敏感字段模式: 审计详情入库前必须脱敏，防止明文密钥/密码落库 */
const SENSITIVE_KEY_PATTERN = /(api_?key|apikey|secret|password|passwd|token|authorization|credential)/i;

function sanitizeDetail(detail) {
  if (detail === null || typeof detail !== 'object') return detail;
  const clone = Array.isArray(detail) ? [...detail] : { ...detail };
  for (const [k, v] of Object.entries(clone)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      clone[k] = '***';
    } else if (v && typeof v === 'object') {
      clone[k] = sanitizeDetail(v);
    }
  }
  return clone;
}

/**
 * 管理操作审计日志
 * 记录谁在什么时候对什么对象做了什么操作
 */
async function audit({ actorId, actorName, action, targetType, targetId, detail, ip }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actorId || null, actorName || null, action, targetType || null,
       targetId !== undefined && targetId !== null ? String(targetId) : null,
       detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
       ip || null]
    );
  } catch (err) {
    logger.warn('审计日志写入失败', { error: err.message, action });
  }
}

/** 审计中间件: 自动从 req 提取操作者信息 */
function auditMiddleware(action, targetType, extractTargetId) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode >= 200 && res.statusCode < 400 && req.user) {
        const targetId = extractTargetId ? extractTargetId(req) : req.params.id || null;
        audit({
          actorId: req.user.id,
          actorName: req.user.username,
          action,
          targetType,
          targetId,
          detail: sanitizeDetail({ method: req.method, path: req.originalUrl, body: req.body }),
          ip: req.ip,
        }).catch(() => {});
      }
      return originalJson(data);
    };
    next();
  };
}

module.exports = { audit, auditMiddleware };
