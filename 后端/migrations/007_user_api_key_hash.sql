-- ============================================
-- WildAPI - 迁移 007: 用户自提交密钥哈希索引
-- 兼容 MySQL 5.7/8.0, 幂等 (仅当列/索引不存在时才 ALTER)
-- 背景: proxyResolver 认证时原为全表解密比对 (O(N))，
-- 未认证的无效密钥请求即可触发全部密钥解密，属 CPU/DB 放大攻击面。
-- 新增 key_hash (sha256, 不可逆) 列后认证走索引查找 (O(1))；
-- key_encrypted 仍保留，供代理转发上游时解密使用。
-- 历史行 key_hash 为 NULL，由认证流程命中时自动回填。
-- ============================================

USE wildapi;

SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'user_api_keys' AND COLUMN_NAME = 'key_hash');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE user_api_keys ADD COLUMN key_hash VARCHAR(64) DEFAULT NULL COMMENT ''密钥 SHA256 哈希, 供认证索引查找'' AFTER key_encrypted',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'user_api_keys' AND INDEX_NAME = 'idx_key_hash');
SET @ddl := IF(@idx_exists = 0,
  'CREATE INDEX idx_key_hash ON user_api_keys (key_hash)',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
