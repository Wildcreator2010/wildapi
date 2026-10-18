-- ============================================
-- WildAPI - 迁移 008: 供应商分类 (厂商类型) 动态化管理
-- 取代前后端硬编码 PROVIDER_TYPES: 支持新增/重命名/删除
-- ============================================

USE wildapi;

CREATE TABLE IF NOT EXISTS provider_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE COMMENT '类型代码 (小写, 如 openai)',
  label VARCHAR(64) NOT NULL COMMENT '显示名称 (如 OpenAI)',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 内置默认分类 (幂等: 已存在则跳过)
INSERT IGNORE INTO provider_types (code, label, sort_order) VALUES
  ('openai', 'OpenAI', 1),
  ('azure', 'Azure OpenAI', 2),
  ('anthropic', 'Claude', 3),
  ('gemini', 'Gemini', 4),
  ('custom', '自定义', 5);
