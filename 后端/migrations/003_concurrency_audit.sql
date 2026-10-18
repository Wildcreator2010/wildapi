-- ============================================
-- WildAPI - 迁移 003: 并发控制 + 倍率定价 + 审计日志 + 模型上下架
-- 兼容 MySQL 5.7/8.0 (不支持 ADD COLUMN IF NOT EXISTS, 用条件判断)
-- ============================================

USE wildapi;

-- 用户并发数上限 (每用户同时进行的代理请求数)
SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'users' AND COLUMN_NAME = 'concurrent_limit');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE users ADD COLUMN concurrent_limit INT NOT NULL DEFAULT 3 COMMENT ''用户并发请求上限'' AFTER is_active',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 定价倍率 (用户价 = 基准价 x 倍率; 不填价格时用上游成本 x 倍率)
SET @col_exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'pricing_configs' AND COLUMN_NAME = 'multiplier');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE pricing_configs ADD COLUMN multiplier DECIMAL(6, 3) NOT NULL DEFAULT 1.000 COMMENT ''定价倍率'' AFTER completion_price',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 管理操作审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_id INT DEFAULT NULL COMMENT '操作者用户 ID',
  actor_name VARCHAR(64) DEFAULT NULL,
  action VARCHAR(64) NOT NULL COMMENT '操作类型: pricing.create, provider.update, admin.revoke, user.adjust ...',
  target_type VARCHAR(32) DEFAULT NULL COMMENT '对象类型: pricing/provider/user/key',
  target_id VARCHAR(64) DEFAULT NULL,
  detail TEXT DEFAULT NULL COMMENT '操作详情 JSON',
  ip VARCHAR(64) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_action (action),
  INDEX idx_actor (actor_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
