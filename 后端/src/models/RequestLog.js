const { pool } = require('../config/database');

/** 日期参数格式校验: 防非法日期串在严格模式下 500、宽松模式下变成 0000-00-00 的错误结果集 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( ?\d{2}:\d{2}(:\d{2})?)?$/;

function safeDate(value) {
  if (!value || typeof value !== 'string') return null;
  return DATE_PATTERN.test(value.trim()) ? value.trim() : null;
}

class RequestLog {
  static async create(data) {
    const {
      userId = null, providerId = null, providerKeyId = null,
      model = null, requestBody = null, responseBody = null,
      latencyMs = null, statusCode = null,
      tokensIn = 0, tokensOut = 0, cost = 0.0,
      errorMessage = null,
    } = data;
    const [result] = await pool.query(
      `INSERT INTO request_logs 
       (user_id, provider_id, provider_key_id, model, request_body, response_body, 
        latency_ms, status_code, tokens_in, tokens_out, cost, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, providerId, providerKeyId, model,
       requestBody ? JSON.stringify(requestBody) : null,
       responseBody ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : null,
       latencyMs, statusCode, tokensIn, tokensOut, cost, errorMessage]
    );
    return this.findById(result.insertId);
  }

  static async findById(id) {
    const [rows] = await pool.query('SELECT * FROM request_logs WHERE id = ?', [id]);
    return rows[0] || null;
  }

  static async list({ page = 1, pageSize = 20, userId, model, statusCode, startDate, endDate, search }) {
    const conditions = [];
    const params = [];
    if (userId) { conditions.push('rl.user_id = ?'); params.push(userId); }
    if (model) { conditions.push('rl.model LIKE ?'); params.push(`%${model}%`); }
    if (statusCode) { conditions.push('rl.status_code = ?'); params.push(statusCode); }
    const safeStart = safeDate(startDate);
    const safeEnd = safeDate(endDate);
    if (safeStart) { conditions.push('rl.created_at >= ?'); params.push(safeStart); }
    if (safeEnd) { conditions.push('rl.created_at <= ?'); params.push(safeEnd); }
    if (search) {
      conditions.push('(rl.model LIKE ? OR rl.error_message LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    // 分页参数兜底: 防 NaN/负值进入 SQL 导致 500 (旧实现依赖调用方校验，这里自保)
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safePageSize = Math.min(Math.max(1, parseInt(pageSize, 10) || 20), 100);
    const offset = (safePage - 1) * safePageSize;

    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM request_logs rl ${where}`, params
    );
    const [rows] = await pool.query(
      `SELECT rl.*, u.username as user_name, p.name as provider_name
       FROM request_logs rl
       LEFT JOIN users u ON rl.user_id = u.id
       LEFT JOIN providers p ON rl.provider_id = p.id
       ${where}
       ORDER BY rl.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safePageSize, offset]
    );
    return { list: rows, total: countResult[0].total, page: safePage, pageSize: safePageSize };
  }
}

module.exports = RequestLog;
