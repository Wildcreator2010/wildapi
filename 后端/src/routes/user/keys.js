const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const UserProxyKey = require('../../models/UserProxyKey');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const logger = require('../../utils/logger');

/**
 * 用户代理分发密钥 (ak- 前缀)
 * 明文仅在创建时返回一次，数据库只存 sha256 哈希
 * 每用户最多 20 个有效密钥
 */

// 密钥列表 (掩码展示)
router.get('/keys', requireAuth, async (req, res, next) => {
  try {
    const list = await UserProxyKey.listByUser(req.user.id);
    res.json({
      success: true,
      data: {
        list,
        maxKeys: UserProxyKey.MAX_KEYS_PER_USER,
        activeCount: list.filter(k => k.is_active).length,
      },
    });
  } catch (err) { next(err); }
});

// 创建密钥 (明文仅此一次; 锁用户行后计数+插入同事务，防并发突破 20 把上限)
router.post('/keys', requireAuth, async (req, res, next) => {
  try {
    const { name } = req.body;
    const { pool } = require('../../config/database');
    const conn = await pool.getConnection();
    let key;
    try {
      await conn.beginTransaction();
      await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
      const [cnt] = await conn.query(
        'SELECT COUNT(*) as total FROM user_proxy_keys WHERE user_id = ? AND is_active = 1',
        [req.user.id]
      );
      if (cnt[0].total >= UserProxyKey.MAX_KEYS_PER_USER) {
        await conn.rollback();
        throw new ValidationError(`已达到密钥数量上限 (${UserProxyKey.MAX_KEYS_PER_USER} 个)，请先删除不再使用的密钥`);
      }
      key = await UserProxyKey.create({ userId: req.user.id, name }, conn);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    logger.info('用户创建代理密钥', { userId: req.user.id, keyId: key.id });

    res.status(201).json({
      success: true,
      message: '密钥创建成功，请立即复制保存，此后无法再次查看',
      data: { key },
    });
  } catch (err) { next(err); }
});

// 重命名密钥
router.put('/keys/:id', requireAuth, async (req, res, next) => {
  try {
    const { name } = req.body;
    const key = await UserProxyKey.rename(parseInt(req.params.id), req.user.id, name);
    if (!key) throw new NotFoundError('密钥不存在');
    res.json({ success: true, message: '已重命名', data: { key } });
  } catch (err) { next(err); }
});

// 启用/禁用密钥
router.put('/keys/:id/toggle', requireAuth, async (req, res, next) => {
  try {
    const key = await UserProxyKey.toggleActive(parseInt(req.params.id), req.user.id);
    if (!key) throw new NotFoundError('密钥不存在');
    res.json({ success: true, data: { key } });
  } catch (err) { next(err); }
});

// 删除密钥 (立即失效)
router.delete('/keys/:id', requireAuth, async (req, res, next) => {
  try {
    const deleted = await UserProxyKey.delete(parseInt(req.params.id), req.user.id);
    if (!deleted) throw new NotFoundError('密钥不存在');
    res.json({ success: true, message: '密钥已删除并立即失效' });
  } catch (err) { next(err); }
});

module.exports = router;
