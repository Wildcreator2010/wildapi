const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * 统一错误处理中间件
 * 捕获所有抛出的错误并返回统一的 JSON 格式
 */
function errorHandler(err, req, res, _next) {
  // 响应已发出 (如流式响应中断后)，无法再写错误 JSON，交给上层处理
  if (res.headersSent) return _next(err);

  // 记录错误
  if (err.statusCode >= 500 || !err.isOperational) {
    logger.error('未处理异常', {
      message: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
    });
  } else {
    logger.warn('业务异常', {
      code: err.code,
      message: err.message,
      url: req.originalUrl,
    });
  }

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  // OpenAI 兼容的错误格式
  const errorResponse = {
    error: {
      message: err.isOperational
        ? err.message
        : '服务器内部错误，请稍后重试',
      type: code,
      code: statusCode,
    },
  };

  res.status(statusCode).json(errorResponse);
}

module.exports = { errorHandler };
