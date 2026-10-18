-- ============================================
-- WildAPI - 数据库初始化迁移
-- 数据库: MySQL 8.0+
-- ============================================

CREATE DATABASE IF NOT EXISTS wildapi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE wildapi;

-- 用户表 (关联 WildAccount 认证中心)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  wildaccount_id VARCHAR(64) UNIQUE NOT NULL COMMENT 'WildAccount 用户 ID (UUID)',
  username VARCHAR(64) NOT NULL,
  email VARCHAR(128) DEFAULT NULL,
  role ENUM('superadmin', 'admin', 'user') NOT NULL DEFAULT 'user',
  balance DECIMAL(12, 6) NOT NULL DEFAULT 0.000000 COMMENT '账户余额 (美元)',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_wildaccount_id (wildaccount_id),
  INDEX idx_role (role),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用户 API 密钥表 (用户自提交的外部 AI 密钥, AES-256-GCM 加密存储)
CREATE TABLE IF NOT EXISTS user_api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  provider VARCHAR(32) NOT NULL COMMENT '服务商标识: openai, azure, anthropic, custom',
  key_name VARCHAR(64) DEFAULT NULL COMMENT '密钥别名',
  key_encrypted TEXT NOT NULL COMMENT 'AES-256-GCM 加密的 API 密钥',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 上游 AI 服务商表
CREATE TABLE IF NOT EXISTS providers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL COMMENT '服务商名称',
  type VARCHAR(32) NOT NULL COMMENT '类型: openai, azure, anthropic, custom',
  base_url VARCHAR(256) NOT NULL COMMENT 'API 基础地址',
  weight INT NOT NULL DEFAULT 1 COMMENT '路由权重',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 上游 API 密钥池 (加密存储)
CREATE TABLE IF NOT EXISTS provider_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  provider_id INT NOT NULL,
  key_name VARCHAR(64) DEFAULT NULL,
  key_encrypted TEXT NOT NULL COMMENT 'AES-256-GCM 加密的 API 密钥',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  usage_count BIGINT NOT NULL DEFAULT 0 COMMENT '累计使用次数',
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  cooldown_until TIMESTAMP NULL DEFAULT NULL COMMENT '冷却截止时间',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  INDEX idx_provider_active (provider_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 模型路由表
CREATE TABLE IF NOT EXISTS model_routes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  model_pattern VARCHAR(128) NOT NULL COMMENT '模型匹配模式, 支持通配符: gpt-4*, claude-*',
  provider_id INT NOT NULL,
  priority INT NOT NULL DEFAULT 0 COMMENT '优先级, 数字越小越高',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  INDEX idx_pattern (model_pattern),
  INDEX idx_priority (priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 速率限制配置表 (每服务商)
CREATE TABLE IF NOT EXISTS rate_limit_configs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  provider_id INT UNIQUE NOT NULL,
  requests_per_minute INT NOT NULL DEFAULT 60,
  concurrent_limit INT NOT NULL DEFAULT 10,
  retry_attempts INT NOT NULL DEFAULT 3,
  retry_delay_ms INT NOT NULL DEFAULT 1000,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 请求日志表 (完整审计追踪)
CREATE TABLE IF NOT EXISTS request_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  provider_id INT DEFAULT NULL,
  provider_key_id INT DEFAULT NULL,
  model VARCHAR(64) DEFAULT NULL COMMENT '请求的模型名称',
  request_body LONGTEXT DEFAULT NULL COMMENT '原始请求体(JSON)',
  response_body LONGTEXT DEFAULT NULL COMMENT '原始响应体(JSON), 错误时存错误信息',
  latency_ms INT DEFAULT NULL COMMENT '响应延迟(毫秒)',
  status_code SMALLINT DEFAULT NULL COMMENT '上游返回的状态码',
  tokens_in INT NOT NULL DEFAULT 0 COMMENT '输入 token 数',
  tokens_out INT NOT NULL DEFAULT 0 COMMENT '输出 token 数',
  cost DECIMAL(12, 6) NOT NULL DEFAULT 0.000000 COMMENT '本次请求费用',
  error_message TEXT DEFAULT NULL COMMENT '错误信息',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_provider_id (provider_id),
  INDEX idx_model (model),
  INDEX idx_status_code (status_code),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 余额变动流水表
CREATE TABLE IF NOT EXISTS user_balance_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount DECIMAL(12, 6) NOT NULL COMMENT '变动金额(正为充值, 负为消费)',
  type ENUM('admin_recharge', 'api_consumption', 'refund', 'initial') NOT NULL,
  balance_before DECIMAL(12, 6) NOT NULL,
  balance_after DECIMAL(12, 6) NOT NULL,
  reference_id VARCHAR(128) DEFAULT NULL COMMENT '关联ID(如 request_logs.id)',
  note VARCHAR(256) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 系统设置表 (键值对)
CREATE TABLE IF NOT EXISTS system_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(64) UNIQUE NOT NULL,
  setting_value TEXT NOT NULL,
  description VARCHAR(256) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 插入默认系统设置
-- INSERT IGNORE 而非 ON DUPLICATE KEY UPDATE: 迁移器每次部署都会重跑全部脚本，
-- 覆盖式写入会把管理员改过的设置悄悄还原成源码默认值
INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES
  ('global_rate_limit', '600', '全局每分钟最大请求数'),
  ('default_retry_attempts', '3', '默认重试次数'),
  ('default_retry_delay_ms', '1000', '默认重试间隔(毫秒)'),
  ('request_body_max_size_mb', '10', '请求体最大大小(MB)');
