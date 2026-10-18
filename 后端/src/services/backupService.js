const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { config } = require('../config');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');

// 确保备份目录存在
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * 数据库备份恢复服务
 * 注意: 使用 execFile + MYSQL_PWD 环境变量传递密码，
 * 避免 shell 拼接导致密码特殊字符 (如 # $ !) 破坏命令或注入，
 * 且密码不会出现在进程列表中
 */

/**
 * 构造 mysql 客户端调用 (execFile 参数数组方式)
 * @param {string} tool - 'mysqldump' 或 'mysql'
 * @param {string[]} args - 额外参数
 */
function buildMysqlCall(tool, args = []) {
  const db = config.db;
  const baseArgs = [
    `-h${db.host}`,
    `-P${String(db.port)}`,
    `-u${db.user}`,
  ];
  const env = { ...process.env };
  if (db.password) {
    env.MYSQL_PWD = db.password; // 密码走环境变量，不进命令行
  }
  return { tool, args: [...baseArgs, ...args], env };
}

/**
 * 列出现有备份文件
 * @returns {Array<{filename, size, createdAt}>}
 */
function listBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql') || f.endsWith('.sql.gz'))
    .map(f => {
      const filePath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(filePath);
      return {
        filename: f,
        size: stat.size,
        sizeFormatted: formatSize(stat.size),
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return files;
}

/**
 * 创建数据库完整备份 (SQL 转储)
 * @returns {{ filename, size, path }}
 */
async function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const filename = `wildapi_backup_${timestamp}.sql`;
  const filePath = path.join(BACKUP_DIR, filename);

  const db = config.db;
  const { tool, args, env } = buildMysqlCall('mysqldump', [
    `--databases`, db.database,
    '--add-drop-database',
    '--add-drop-table',
    '--routines',
    '--triggers',
    '--events',
    '--single-transaction',
    '--set-charset',
    '--default-character-set=utf8mb4',
    '--no-tablespaces',
    `--result-file=${filePath}`,
  ]);

  logger.info('开始数据库备份', { db: db.database, filename });

  try {
    await execFileAsync(tool, args, { env, timeout: 300000 });

    const stat = fs.statSync(filePath);

    // 如果文件存在但为空，说明备份失败
    if (stat.size === 0) {
      fs.unlinkSync(filePath);
      throw new Error('备份文件为空，可能数据库连接失败');
    }

    logger.info('数据库备份成功', { filename, size: stat.size });
    return {
      filename,
      size: stat.size,
      sizeFormatted: formatSize(stat.size),
      path: filePath,
    };
  } catch (err) {
    logger.error('数据库备份失败', { error: err.message });
    // 清理可能的空文件
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    throw new Error(`备份失败: ${err.message}`);
  }
}

/**
 * 从 SQL 文件恢复数据库 (支持 .sql 与 .sql.gz/.gz)
 * 文件以流式管道送入 mysql 子进程，不整块读入内存 (防大文件 OOM);
 * .gz 先经 zlib 解压 (旧实现直接喂原始字节给 mysql，压缩包必然恢复失败)
 * @param {string} filePath - SQL 文件绝对路径
 */
async function restoreBackup(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new NotFoundError('备份文件不存在');
  }

  const db = config.db;
  const { tool, args, env } = buildMysqlCall('mysql', [db.database]);

  logger.info('开始数据库恢复', { db: db.database, file: path.basename(filePath) });

  try {
    // 先备份当前数据库 (安全措施)
    const safetyBackup = await createBackup();
    logger.info('恢复前已创建安全备份', { safetyBackup: safetyBackup.filename });

    await new Promise((resolve, reject) => {
      const child = spawn(tool, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stdout.on('data', () => {});
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('恢复超时 (超过 10 分钟)'));
      }, 600000);
      const fail = (err) => { clearTimeout(timer); reject(err); };

      child.on('error', fail);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(stderr.trim() || `mysql 进程退出码 ${code}`));
      });

      // 流式输入: .gz 先解压再送入 (不整块读入内存)
      let stream = fs.createReadStream(filePath);
      if (/\.gz$/i.test(filePath)) {
        stream = stream.pipe(zlib.createGunzip());
      }
      stream.on('error', fail);
      stream.pipe(child.stdin);
    });

    logger.info('数据库恢复成功');
    return { success: true, safetyBackup: safetyBackup.filename };
  } catch (err) {
    logger.error('数据库恢复失败', { error: err.message });
    throw new Error(`恢复失败: ${err.message}`);
  }
}

/**
 * 删除备份文件
 */
function deleteBackup(filename) {
  // 安全检查: 防止路径穿越
  const safeName = path.basename(filename);
  if (safeName !== filename) throw new ValidationError('非法的文件名');

  const filePath = path.join(BACKUP_DIR, safeName);
  if (!fs.existsSync(filePath)) throw new NotFoundError('备份文件不存在');

  fs.unlinkSync(filePath);
  logger.info('备份文件已删除', { filename: safeName });
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

module.exports = {
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  BACKUP_DIR,
  buildMysqlCall,
};
