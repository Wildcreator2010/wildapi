#!/usr/bin/env node
/**
 * ============================================
 * WildAPI - 全量语法检查
 * ============================================
 * 对 src 与 scripts 下每个 .js 跑 `node --check`，再逐个 require 一遍
 * （require 能抓到语法之外的问题：导出名写错、循环依赖、拼错的标识符）。
 * app.js 只 check 不 require —— require 它会把服务真跑起来。
 *
 * 使用方式: npm run check:syntax
 * 退出码: 0 = 全部通过, 1 = 有文件不通过
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]
  .filter((f) => !f.endsWith(path.join('scripts', 'check-syntax.js')));

let failed = 0;

for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.log(`[SYNTAX FAIL] ${path.relative(ROOT, f)}: ${(r.stderr || '').split('\n')[0]}`);
  }
}

// require 级检查（跳过会启动监听/连库的入口与测试脚本）
const skip = new Set([
  path.join(ROOT, 'src', 'app.js'),
  path.join(ROOT, 'scripts', 'test-relay.js'),
  path.join(ROOT, 'scripts', 'test-e2e-db.js'),
  path.join(ROOT, 'scripts', 'migrate.js'),
  path.join(ROOT, 'scripts', 'setup-mysql.js'),
]);

for (const f of files) {
  if (skip.has(f)) continue;
  try {
    require(f);
  } catch (err) {
    failed++;
    console.log(`[LOAD FAIL] ${path.relative(ROOT, f)}: ${err.message.split('\n')[0]}`);
  }
}

console.log(`语法与加载检查: ${files.length - failed}/${files.length} 通过`);
process.exit(failed ? 1 : 0);
