const winston = require('winston');
const fs = require('fs');
const path = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'wildapi' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1 ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} ${level}: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

// 生产环境写文件日志
if (process.env.NODE_ENV === 'production') {
  // 目录必须先建好: winston 在 require 阶段就打开文件，目录不存在时 (本地 npm start、
  // 或 bind mount 属主不符) 直接抛异常让进程起不来
  const logDir = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(process.cwd(), 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    // 只读文件系统/权限不足时降级为纯控制台输出，不阻断启动
    console.warn(`[logger] 无法创建日志目录 ${logDir} (${err.message})，仅输出到控制台`);
  }
  if (fs.existsSync(logDir) && fs.statSync(logDir).isDirectory()) {
    logger.add(
      new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error', maxsize: 10485760 })
    );
    logger.add(
      new winston.transports.File({ filename: path.join(logDir, 'combined.log'), maxsize: 10485760 })
    );
  }
}

module.exports = logger;
