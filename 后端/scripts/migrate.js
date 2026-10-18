/**
 * ============================================
 * WildAPI - 数据库迁移执行器
 * ============================================
 * 按文件名顺序执行 migrations/ 目录下全部 .sql 文件
 * (001_initial → ... → 当前最新编号，新增迁移文件即自动纳入执行)
 *
 * 迁移脚本自身幂等 (IF NOT EXISTS / information_schema 条件判断)，
 * 可安全重复执行。
 *
 * 使用方式: npm run migrate
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  if (files.length === 0) {
    console.error('未找到迁移文件 (migrations/*.sql)');
    process.exit(1);
  }

  // 专用连接: 开启 multipleStatements 以整文件执行
  // (共享连接池 src/config/database.js 未开启该选项，不在此复用)
  // 不指定 database: 001 内含 CREATE DATABASE / USE
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      process.stdout.write(`[migrate] 执行 ${file} ... `);
      await conn.query(sql);
      console.log('OK');
    }
    console.log(`\n全部 ${files.length} 个迁移执行完成`);
  } catch (err) {
    console.error(`\n[migrate] 迁移失败: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[migrate] 数据库连接失败:', err.message);
  console.error('[提示] 请先在 .env 中配置数据库信息，或运行 npm run setup-mysql');
  process.exit(1);
});
