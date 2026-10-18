-- ============================================
-- WildAPI - 迁移 010: 余额与流水改用 6 位小数
-- 兼容 MySQL 5.7/8.0, 幂等 (仅当小数位不足 6 位时才 ALTER)
--
-- 背景: request_logs.cost 是 DECIMAL(12,6)，扣费时按 6 位算，
-- 写入 users.balance / user_balance_transactions 却按 4 位四舍五入。
-- 单次成本低于 $0.00005 的调用 (小模型短对话很常见) 扣费落成 0，
-- 但日志里的成本不为 0 —— 余额和"流水之和"会长期对不上，且高频低价模型实际白跑。
-- 统一成 6 位后，账单、流水、余额三者同源。
-- ============================================

USE wildapi;

-- 1. users.balance
SET @need := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'balance' AND NUMERIC_SCALE < 6);
SET @ddl := IF(@need > 0,
  'ALTER TABLE users MODIFY COLUMN balance DECIMAL(12, 6) NOT NULL DEFAULT 0.000000 COMMENT ''账户余额 (美元)''',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. user_balance_transactions.amount
SET @need := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'user_balance_transactions'
    AND COLUMN_NAME = 'amount' AND NUMERIC_SCALE < 6);
SET @ddl := IF(@need > 0,
  'ALTER TABLE user_balance_transactions MODIFY COLUMN amount DECIMAL(12, 6) NOT NULL COMMENT ''变动金额(正为充值, 负为消费)''',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. user_balance_transactions.balance_before
SET @need := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'user_balance_transactions'
    AND COLUMN_NAME = 'balance_before' AND NUMERIC_SCALE < 6);
SET @ddl := IF(@need > 0,
  'ALTER TABLE user_balance_transactions MODIFY COLUMN balance_before DECIMAL(12, 6) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. user_balance_transactions.balance_after
SET @need := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'wildapi' AND TABLE_NAME = 'user_balance_transactions'
    AND COLUMN_NAME = 'balance_after' AND NUMERIC_SCALE < 6);
SET @ddl := IF(@need > 0,
  'ALTER TABLE user_balance_transactions MODIFY COLUMN balance_after DECIMAL(12, 6) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
