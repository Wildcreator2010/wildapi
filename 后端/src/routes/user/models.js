const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const ModelRoute = require('../../models/ModelRoute');
const ModelAvailability = require('../../models/ModelAvailability');

/**
 * GET /api/user/models
 * 用户端模型清单: 优先上游检测可用模型，回退本地已上架 (与 /v1/models 数据源一致)
 */

/**
 * 按厂商类型与模型名推断支持的调用协议
 */
function inferProtocols(modelPattern, providerType) {
  const model = modelPattern.toLowerCase();
  if (model.includes('embedding') || model.includes('embed')) {
    return ['/v1/embeddings'];
  }
  if (providerType === 'anthropic') {
    return ['/v1/messages', '/v1/chat/completions'];
  }
  return ['/v1/chat/completions', '/v1/completions'];
}

router.get('/models', requireAuth, async (req, res, next) => {
  try {
    // 1. 优先: 上游检测可用模型 (来自 model_availability, 已去重/排序/容错)
    const upstream = await ModelAvailability.listAvailableSafe();
    if (upstream.length > 0) {
      const list = upstream.map(m => ({
        model: m.model,
        modelHint: m.model,
        providerName: m.providerName,
        providerType: m.providerType,
        protocols: inferProtocols(m.model, m.providerType),
        latencyMs: m.latencyMs,
        status: '可用',
        source: 'upstream',
        hasWildcard: false,
      }));
      return res.json({ success: true, data: { list, total: list.length } });
    }

    // 2. 回退: 本地已上架路由 (仅 is_active = 1)
    const routes = await ModelRoute.list();
    const models = routes.map(r => {
      const hasWildcard = r.model_pattern.includes('*');
      return {
        model: r.model_pattern,
        modelHint: hasWildcard ? `${r.model_pattern}（前缀匹配）` : r.model_pattern,
        providerId: r.provider_id,
        providerName: r.provider_name || '默认服务商',
        providerType: r.provider_type || 'openai',
        protocols: inferProtocols(r.model_pattern, r.provider_type || 'openai'),
        status: '上架',
        source: 'local',
        hasWildcard,
      };
    });

    res.json({ success: true, data: { list: models, total: models.length } });
  } catch (err) { next(err); }
});

module.exports = router;
