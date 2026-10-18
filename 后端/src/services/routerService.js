const ModelRoute = require('../models/ModelRoute');
const logger = require('../utils/logger');

/**
 * 模型路由服务
 * 根据请求的 model 参数匹配上游服务商
 */
async function resolveRoute(model) {
  if (!model) {
    logger.warn('路由解析: 请求未指定 model');
    return null;
  }

  const route = await ModelRoute.matchModel(model);
  if (!route) {
    logger.error('路由解析: 没有可用的上游服务商');
    return null;
  }

  logger.info('路由解析成功', {
    model,
    providerId: route.provider_id,
    providerName: route.provider_name,
    pattern: route.model_pattern,
  });

  return {
    providerId: route.provider_id,
    providerName: route.provider_name,
    providerType: route.provider_type,
    pattern: route.model_pattern,
  };
}

module.exports = { resolveRoute };
