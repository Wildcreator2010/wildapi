-- ============================================
-- WildAPI - 迁移 005: wildaccount_id INT -> VARCHAR(64)
-- 认证中心用户 ID 为 UUID 字符串 (crypto.randomUUID)
-- 兼容 MySQL 5.7/8.0, 幂等 (仅当列仍为 int 时才 ALTER)
-- ============================================

USE wildapi;

SET @col_type := (SELECT DATA_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'users' AND COLUMN_NAME = 'wildaccount_id');
SET @ddl := IF(@col_type = 'int',
  'ALTER TABLE users MODIFY COLUMN wildaccount_id VARCHAR(64) NOT NULL COMMENT ''WildAccount 用户 ID (UUID)''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
