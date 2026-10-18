-- ============================================
-- WildAPI - 迁移 006: 用户 RPM (每分钟请求数) 限制
-- 兼容 MySQL 5.7/8.0, 幂等 (仅当列不存在时才 ALTER)
-- 与 concurrent_limit (并发上限) 相互独立:
--   concurrent_limit = 同一时刻进行中的请求数
--   rpm_limit        = 每分钟发起的请求数 (NULL = 使用系统默认 120)
-- ============================================

USE wildapi;

SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'users' AND COLUMN_NAME = 'rpm_limit');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE users ADD COLUMN rpm_limit INT DEFAULT NULL COMMENT ''用户每分钟请求数上限, NULL 使用系统默认'' AFTER concurrent_limit',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
