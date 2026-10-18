const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const Provider = require('../../models/Provider');
const ProviderKey = require('../../models/ProviderKey');
const availabilityService = require('../../services/availabilityService');
const { pool } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const logger = require('../../utils/logger');

/**
 * 上游模型发现与可用性检测接口
 */

// 查看某服务商的可用性检测结果 (密钥汇总 + 模型明细)
router.get('/:id/availability', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const providerId = parseInt(req.params.id);
    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('服务商不存在');

    // 密钥汇总: 每把 key 的模型数 + 异常数 + 最新状态
    const [keySummary] = await pool.query(
      `SELECT pk.id as key_id, pk.key_name, pk.is_active,
              COUNT(ma.id) as model_count,
              SUM(ma.status = 'auth_failed') as auth_failed_count,
              SUM(ma.status = 'unreachable') as unreachable_count,
              SUM(ma.status = 'available') as available_count,
              MAX(ma.checked_at) as last_checked
       FROM provider_keys pk
       LEFT JOIN model_availability ma ON ma.provider_key_id = pk.id AND ma.model != '__key__'
       WHERE pk.provider_id = ?
       GROUP BY pk.id, pk.key_name, pk.is_active
       ORDER BY pk.id ASC`,
      [providerId]
    );

    // 模型明细
    const [models] = await pool.query(
      `SELECT ma.id, ma.provider_key_id, pk.key_name, ma.model, ma.status, ma.latency_ms, ma.error, ma.checked_at
       FROM model_availability ma
       JOIN provider_keys pk ON pk.id = ma.provider_key_id
       WHERE ma.provider_id = ?
       ORDER BY ma.checked_at DESC
       LIMIT 500`,
      [providerId]
    );

    res.json({
      success: true,
      data: {
        provider: { id: provider.id, name: provider.name, type: provider.type },
        keySummary,
        models,
        intervalMinutes: availabilityService.DEFAULT_INTERVAL_MIN,
      },
    });
  } catch (err) { next(err); }
});

// 立即检测某服务商的全部活跃密钥
router.post('/:id/discover', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const providerId = parseInt(req.params.id);
    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('服务商不存在');

    const keys = await ProviderKey.listByProvider(providerId);
    const activeKeys = keys.filter(k => k.is_active);
    if (activeKeys.length === 0) throw new ValidationError('该服务商没有活跃密钥');

    logger.info('管理员手动触发可用性检测', { adminId: req.user.id, providerId });

    // 异步执行避免请求超时; 立即返回受理
    (async () => {
      let totalDiscovered = 0;
      let totalFailed = 0;
      for (const k of activeKeys) {
        const result = await availabilityService.checkKey(provider, k);
        totalDiscovered += result.discovered;
        totalFailed += result.failed;
      }
      logger.info('手动检测完成', { providerId, totalDiscovered, totalFailed });
    })().catch(err => logger.error('手动检测异常', { error: err.message }));

    res.json({
      success: true,
      message: `已开始检测 ${activeKeys.length} 把密钥，完成后结果将展示在可用性列表`,
    });
  } catch (err) { next(err); }
});

// 立即检测单把密钥
router.post('/:id/keys/:keyId/check', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const provider = await Provider.findById(parseInt(req.params.id));
    if (!provider) throw new NotFoundError('服务商不存在');
    const key = await ProviderKey.findById(parseInt(req.params.keyId));
    // 密钥必须属于 URL 里的服务商: 否则会用 A 的 base_url 探 B 的密钥，
    // 并把错位的 provider_id/provider_key_id 组合写进 model_availability，污染 A 的可用性数据
    if (!key || key.provider_id !== provider.id) throw new NotFoundError('密钥不存在');

    (async () => {
      await availabilityService.checkKey(provider, key);
    })().catch(err => logger.error('单密钥检测异常', { error: err.message }));

    res.json({ success: true, message: '已开始检测该密钥' });
  } catch (err) { next(err); }
});

module.exports = router;
