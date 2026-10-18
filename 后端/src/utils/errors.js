/**
 * 自定义错误类
 */

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class AuthError extends AppError {
  constructor(message = '未授权访问') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = '权限不足') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ValidationError extends AppError {
  constructor(message = '参数校验失败') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

class RateLimitError extends AppError {
  constructor(message = '请求过于频繁，请稍后再试') {
    super(message, 429, 'RATE_LIMITED');
  }
}

class InsufficientBalanceError extends AppError {
  constructor(message = '余额不足，请充值后重试') {
    super(message, 402, 'INSUFFICIENT_BALANCE');
  }
}

class UpstreamError extends AppError {
  constructor(message = '上游服务返回错误', upstreamStatus = 502) {
    super(message, 502, 'UPSTREAM_ERROR');
    this.upstreamStatus = upstreamStatus;
  }
}

module.exports = {
  AppError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  InsufficientBalanceError,
  UpstreamError,
};
