-- ============================================
-- WildAPI - 迁移 009: 加宽 request_logs.model
-- 兼容 MySQL 5.7/8.0, 幂等 (仅当列宽不是 128 时才 ALTER)
--
-- 背景: request_logs.model 为 VARCHAR(64)，而 model_routes.model_pattern 与
-- model_availability.model 都是 VARCHAR(128)。可用性检测会把上游返回的任意模型 id
-- 自动注册成路由，长模型名 (网关类前缀很容易超过 64 字符) 写入日志时在
-- STRICT_TRANS_TABLES 下报错 → 结算事务回滚 → 该请求既不扣费也无日志，
-- 且代理链路只留下 settle_failed 记录。
-- ============================================

USE wildapi;

SET @need_widen := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'request_logs'
    AND COLUMN_NAME = 'model' AND CHARACTER_MAXIMUM_LENGTH < 128);
SET @ddl := IF(@need_widen > 0,
  'ALTER TABLE request_logs MODIFY COLUMN model VARCHAR(128) DEFAULT NULL COMMENT ''请求的模型名称''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
