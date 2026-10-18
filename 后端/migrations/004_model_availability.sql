-- ============================================
-- WildAPI - 迁移 004: 上游模型发现与可用性检测
-- ============================================

USE wildapi;

-- 模型可用性检测记录 (每个服务商密钥 x 模型 一条)
CREATE TABLE IF NOT EXISTS model_availability (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider_id INT NOT NULL COMMENT '服务商 ID',
  provider_key_id INT NOT NULL COMMENT '上游密钥 ID',
  model VARCHAR(128) NOT NULL COMMENT '模型 ID (上游 /v1/models 返回)',
  status ENUM('available', 'auth_failed', 'unreachable', 'unknown') NOT NULL DEFAULT 'unknown'
    COMMENT 'available=可用, auth_failed=密钥失效(401/403), unreachable=不可达(5xx/超时/网络)',
  latency_ms INT DEFAULT NULL COMMENT '探测延迟(毫秒)',
  error TEXT DEFAULT NULL COMMENT '失败原因',
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_key_model (provider_key_id, model),
  INDEX idx_provider (provider_id),
  INDEX idx_status (status),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_key_id) REFERENCES provider_keys(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
