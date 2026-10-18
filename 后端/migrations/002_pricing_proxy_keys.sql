-- ============================================
-- WildAPI - 迁移 002: 动态定价 + 用户代理分发密钥
-- ============================================

USE wildapi;

-- 模型动态定价表 (按模型 + 厂商类型区分，代理扣费时实时生效)
CREATE TABLE IF NOT EXISTS pricing_configs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  model_pattern VARCHAR(128) NOT NULL COMMENT '模型匹配模式, 支持通配符: gpt-4*, claude-*',
  provider_type VARCHAR(32) NOT NULL DEFAULT 'openai' COMMENT '厂商类型: openai, azure, anthropic, gemini, custom',
  prompt_price DECIMAL(12, 6) NOT NULL DEFAULT 0.000000 COMMENT '输入 token 单价 (美元/1K tokens)',
  completion_price DECIMAL(12, 6) NOT NULL DEFAULT 0.000000 COMMENT '输出 token 单价 (美元/1K tokens)',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_model_provider (model_pattern, provider_type),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用户代理分发密钥表 (系统生成，明文仅创建时展示一次，库中只存 sha256 哈希)
CREATE TABLE IF NOT EXISTS user_proxy_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(64) DEFAULT NULL COMMENT '密钥自定义名称',
  key_prefix VARCHAR(16) NOT NULL COMMENT '密钥前缀 (掩码展示用)',
  key_hash CHAR(64) NOT NULL COMMENT '完整密钥的 sha256 十六进制',
  key_suffix VARCHAR(8) NOT NULL COMMENT '密钥后缀 (掩码展示用)',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_key_hash (key_hash),
  INDEX idx_user_active (user_id, is_active),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 余额流水类型补充 (支持管理员手动扣减)
ALTER TABLE user_balance_transactions
  MODIFY COLUMN type ENUM('admin_recharge', 'admin_adjust', 'api_consumption', 'refund', 'initial') NOT NULL;
