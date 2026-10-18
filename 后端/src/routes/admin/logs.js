const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const RequestLog = require('../../models/RequestLog');
const { pool } = require('../../config/database');

// 获取请求日志列表 (支持搜索/过滤/高亮)
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { page, pageSize, userId, model, statusCode, startDate, endDate, search } = req.query;
    const result = await RequestLog.list({
      page: parseInt(page) || 1,
      pageSize: Math.min(parseInt(pageSize) || 20, 100),
      userId: userId ? parseInt(userId) : undefined,
      model, statusCode: statusCode ? parseInt(statusCode) : undefined,
      startDate, endDate, search,
    });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// 获取状态码分布统计 (静态路径，必须注册在 /:id 之前，否则被 /:id 遮蔽)
router.get('/stats/codes', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT status_code, COUNT(*) as count FROM request_logs 
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY status_code ORDER BY count DESC`
    );
    res.json({ success: true, data: { list: rows } });
  } catch (err) { next(err); }
});

// 获取单条日志详情
router.get('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const log = await RequestLog.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ success: false, error: { message: '日志不存在' } });
    }
    res.json({ success: true, data: { log } });
  } catch (err) { next(err); }
});

module.exports = router;
