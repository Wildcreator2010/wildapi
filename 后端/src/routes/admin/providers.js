const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const Provider = require('../../models/Provider');
const ProviderKey = require('../../models/ProviderKey');
const ModelRoute = require('../../models/ModelRoute');
const RateLimitConfig = require('../../models/RateLimitConfig');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const ProviderType = require('../../models/ProviderType');

/**
 * 厂商类型必须存在于 provider_types: 写错的 code 不会报错，
 * 但会让 PricingConfig 只能落到跨厂商兜底桶，计费口径悄悄跑偏。
 */
async function assertValidProviderType(providerType) {
  const types = await ProviderType.list({ activeOnly: true });
  if (!types.some(t => t.code === providerType)) {
    throw new ValidationError(`未知厂商类型: ${providerType}`);
  }
}

async function assertProviderExists(providerId) {
  const provider = await Provider.findById(providerId);
  if (!provider) throw new NotFoundError('服务商不存在');
  return provider;
}

/**
 * 校验子资源确实属于 URL 里的服务商 (否则可用 A 的 id 改 B 的密钥/路由)
 */
async function assertKeyBelongsToProvider(keyId, providerId) {
  const key = await ProviderKey.findById(keyId);
  if (!key || key.provider_id !== providerId) throw new NotFoundError('密钥不存在');
  return key;
}

async function assertRouteBelongsToProvider(routeId, providerId) {
  const route = await ModelRoute.findById(routeId);
  if (!route || route.provider_id !== providerId) throw new NotFoundError('模型路由不存在');
  return route;
}

// ==================== 上游服务商 CRUD ====================

// 获取所有服务商
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const providers = await Provider.list();
    res.json({ success: true, data: { list: providers } });
  } catch (err) { next(err); }
});

// 创建服务商
router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, type, baseUrl, weight } = req.body;
    if (!name || !type || !baseUrl) throw new ValidationError('缺少必填字段: name, type, baseUrl');
    await assertValidProviderType(type);
    const provider = await Provider.create({ name, type, baseUrl, weight });

    // 自动创建默认速率限制配置
    await RateLimitConfig.upsert(provider.id, {
      requestsPerMinute: 60, concurrentLimit: 10, retryAttempts: 3, retryDelayMs: 1000,
    });

    res.status(201).json({ success: true, data: { provider } });
  } catch (err) { next(err); }
});

// 更新服务商
// 前端发驼峰字段 (baseUrl/isActive)，数据库列为蛇形；统一映射并对未知字段显式报错，
// 避免字段名不匹配时静默丢弃更新 (接口返回 200 但实际未生效)
const PROVIDER_FIELD_ALIASES = {
  name: 'name',
  type: 'type',
  baseUrl: 'base_url',
  base_url: 'base_url',
  weight: 'weight',
  isActive: 'is_active',
  is_active: 'is_active',
};

router.put('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const fields = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      const col = PROVIDER_FIELD_ALIASES[k];
      if (!col) throw new ValidationError(`不支持的更新字段: ${k}`);
      fields[col] = v;
    }
    if (Object.keys(fields).length === 0) throw new ValidationError('未提供任何可更新字段');
    if (fields.type !== undefined) await assertValidProviderType(fields.type);
    const provider = await Provider.update(parseInt(req.params.id), fields);
    if (!provider) throw new NotFoundError('服务商不存在');
    res.json({ success: true, data: { provider } });
  } catch (err) { next(err); }
});

// 删除服务商
router.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await Provider.delete(parseInt(req.params.id));
    res.json({ success: true, message: '已删除' });
  } catch (err) { next(err); }
});

// ==================== 上游密钥池管理 ====================

// 获取某服务商的密钥列表
router.get('/:id/keys', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const keys = await ProviderKey.listByProvider(parseInt(req.params.id));
    res.json({ success: true, data: { list: keys } });
  } catch (err) { next(err); }
});

// 添加密钥
router.post('/:id/keys', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { keyName, rawKey } = req.body;
    if (!rawKey) throw new ValidationError('缺少 rawKey');
    await assertProviderExists(parseInt(req.params.id));
    const key = await ProviderKey.create({ providerId: parseInt(req.params.id), keyName, rawKey });
    res.status(201).json({ success: true, data: { key: { ...key, key_encrypted: undefined } } });
  } catch (err) { next(err); }
});

// 切换密钥状态 (URL 带服务商 id: 必须校验该密钥确实属于它，且不得回传密文字段)
router.put('/:id/keys/:keyId/toggle', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const providerId = parseInt(req.params.id);
    const keyId = parseInt(req.params.keyId);
    await assertKeyBelongsToProvider(keyId, providerId);
    const key = await ProviderKey.toggleActive(keyId);
    if (!key) throw new NotFoundError('密钥不存在');
    const { key_encrypted: _omit, ...safeKey } = key;
    res.json({ success: true, data: { key: safeKey } });
  } catch (err) { next(err); }
});

// 删除密钥
router.delete('/:id/keys/:keyId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await assertKeyBelongsToProvider(parseInt(req.params.keyId), parseInt(req.params.id));
    await ProviderKey.delete(parseInt(req.params.keyId));
    res.json({ success: true, message: '已删除' });
  } catch (err) { next(err); }
});

// ==================== 模型路由管理 ====================

// 获取某服务商的模型路由
router.get('/:id/routes', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const routes = await ModelRoute.listByProvider(parseInt(req.params.id));
    res.json({ success: true, data: { list: routes } });
  } catch (err) { next(err); }
});

// 添加模型路由
router.post('/:id/routes', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { modelPattern, priority } = req.body;
    if (!modelPattern) throw new ValidationError('缺少 modelPattern');
    await assertProviderExists(parseInt(req.params.id));
    const route = await ModelRoute.create({
      providerId: parseInt(req.params.id), modelPattern, priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    });
    res.status(201).json({ success: true, data: { route } });
  } catch (err) { next(err); }
});

// 删除模型路由 (同样按 URL 的服务商 id 校验归属)
router.delete('/:id/routes/:routeId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await assertRouteBelongsToProvider(parseInt(req.params.routeId), parseInt(req.params.id));
    await ModelRoute.delete(parseInt(req.params.routeId));
    res.json({ success: true, message: '已删除' });
  } catch (err) { next(err); }
});

// ==================== 速率限制管理 ====================

// 获取速率限制配置
router.get('/:id/ratelimit', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const config = await RateLimitConfig.findByProviderId(parseInt(req.params.id));
    res.json({ success: true, data: { config } });
  } catch (err) { next(err); }
});

// 更新速率限制配置
router.put('/:id/ratelimit', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const config = await RateLimitConfig.upsert(parseInt(req.params.id), req.body);
    res.json({ success: true, data: { config } });
  } catch (err) { next(err); }
});

module.exports = router;
