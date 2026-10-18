/**
 * ============================================
 * WildAPI - MySQL 自动检测与安装脚本
 * ============================================
 * 功能:
 * 1. 检测本地是否已安装 MySQL 服务
 * 2. 若未安装，自动引导安装 MySQL 社区版
 * 3. 安装完成后自动创建数据库和表结构
 *
 * 使用方式: node scripts/setup-mysql.js [--force] [--root-password=xxx]
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// 必须先加载 .env 再读配置: 本脚本原来不加载 dotenv，
// 导致 .env 里的 DB_USER/DB_PASSWORD/DB_NAME 全部被忽略，永远用 root 空密码尝试连接
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ==================== 配置 ====================

const DB_NAME = process.env.DB_NAME || 'wildapi';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_PORT = process.env.DB_PORT || 3306;
const DB_CHARSET = 'utf8mb4';
const DB_COLLATION = 'utf8mb4_unicode_ci';

// MySQL 社区版下载地址 (Windows MSI)
const MYSQL_VERSION = '8.0.36';
const MYSQL_WIN_URL = `https://dev.mysql.com/get/Downloads/MySQL-8.0/mysql-${MYSQL_VERSION}-windows-x86_64.msi`;
const MYSQL_WIN_INSTALLER = `mysql-${MYSQL_VERSION}-windows-x86_64.msi`;

// ==================== 工具函数 ====================

function log(msg) { console.log(`\x1b[36m[MySQL-Setup]\x1b[0m ${msg}`); }
function success(msg) { console.log(`\x1b[32m[MySQL-Setup]\x1b[0m ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[MySQL-Setup]\x1b[0m ${msg}`); }
function error(msg) { console.log(`\x1b[31m[MySQL-Setup]\x1b[0m ${msg}`); }

function runCommand(cmd, args = [], options = {}) {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', ...options, shell: true });
    if (result.error) throw result.error;
    return { stdout: result.stdout?.trim(), stderr: result.stderr?.trim(), status: result.status };
  } catch (e) {
    return { stdout: '', stderr: e.message, status: 1 };
  }
}

function isWindows() { return os.platform() === 'win32'; }
function isLinux() { return os.platform() === 'linux'; }

// ==================== 检测 MySQL ====================

async function detectMySQL() {
  log('正在检测 MySQL 服务...');

  if (isWindows()) {
    // Windows: 检查服务
    const svc = runCommand('sc', ['query', 'MySQL80']);
    if (svc.stdout?.includes('RUNNING')) {
      success('检测到 MySQL 服务正在运行 (MySQL80)');
      return { installed: true, serviceName: 'MySQL80' };
    }
    // 尝试检查其他可能的服务名
    for (const name of ['MySQL', 'MySQL57', 'MySQL80', 'MariaDB']) {
      const check = runCommand('sc', ['query', name]);
      if (check.stdout?.includes('RUNNING') || check.stdout?.includes('STOPPED')) {
        success(`检测到 MySQL 服务: ${name}`);
        return { installed: true, serviceName: name };
      }
    }
    // 检查 mysql 命令
    const mysqlCheck = runCommand('mysql', ['--version']);
    if (mysqlCheck.stdout?.includes('mysql')) {
      success('检测到 mysql 客户端命令可用');
      return { installed: true };
    }
  }

  if (isLinux()) {
    // Linux: 检查 systemd 服务
    for (const svcName of ['mysqld', 'mysql', 'mariadb']) {
      const check = runCommand('systemctl', ['is-active', svcName]);
      if (check.stdout?.includes('active')) {
        success(`检测到 ${svcName} 服务正在运行`);
        return { installed: true, serviceName: svcName };
      }
    }
    // 检查进程
    const ps = runCommand('pgrep', ['-x', 'mysqld']);
    if (ps.status === 0) {
      success('检测到 mysqld 进程运行中');
      return { installed: true };
    }
    // 检查 mysql 命令
    const mysqlCheck = runCommand('which', ['mysql']);
    if (mysqlCheck.status === 0) {
      success('检测到 mysql 客户端已安装');
      return { installed: true };
    }
  }

  warn('未检测到 MySQL 服务');
  return { installed: false };
}

// ==================== Windows 安装 ====================

async function installWindows(packagePath, rootPassword) {
  log('开始 Windows MySQL 安装流程...');

  // 检查安装包是否存在
  const installerPath = packagePath
    ? path.resolve(packagePath)
    : path.join(__dirname, '..', 'packages', MYSQL_WIN_INSTALLER);

  if (!fs.existsSync(installerPath)) {
    warn(`未找到本地安装包: ${installerPath}`);
    warn('将尝试从官方下载，但推荐提前下载并放置于 packages/ 目录');
    warn(`下载地址: ${MYSQL_WIN_URL}`);

    const download = await askUser('是否继续尝试网络下载? (y/n): ');
    if (download.toLowerCase() !== 'y') {
      error('安装取消。请手动安装 MySQL 后重新运行此脚本。');
      process.exit(1);
    }
    // 网络下载 (需 curl)
    log('正在下载 MySQL 安装包...');
    const dlResult = runCommand('curl', ['-L', '-o', installerPath, MYSQL_WIN_URL], { timeout: 600000 });
    if (!fs.existsSync(installerPath)) {
      error('下载失败，请手动下载安装包');
      process.exit(1);
    }
    success('下载完成');
  }

  log('正在以静默模式安装 MySQL...');
  log('这可能需要几分钟，请耐心等待...');

  // 静默安装参数
  // /quiet: 静默模式 /norestart: 不重启
  const installArgs = [
    '/i', installerPath,
    '/quiet',
    '/norestart',
  ];

  const result = runCommand('msiexec', installArgs, { timeout: 600000 });
  if (result.status !== 0) {
    error('MySQL 安装失败');
    error(result.stderr);
    return false;
  }

  success('MySQL 安装完成');
  return true;
}

// ==================== Linux 安装 ====================

async function installLinux(rootPassword) {
  log('开始 Linux MySQL 安装流程...');

  // 检测包管理器
  const hasApt = runCommand('which', ['apt-get']).status === 0;
  const hasYum = runCommand('which', ['yum']).status === 0;
  const hasDnf = runCommand('which', ['dnf']).status === 0;

  if (hasApt) {
    log('使用 apt 包管理器安装 MySQL...');
    runCommand('sudo', ['apt-get', 'update', '-y']);
    runCommand('sudo', ['DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'mysql-server']);
  } else if (hasDnf) {
    log('使用 dnf 包管理器安装 MySQL...');
    runCommand('sudo', ['dnf', 'install', '-y', 'mysql-server']);
  } else if (hasYum) {
    log('使用 yum 包管理器安装 MySQL...');
    runCommand('sudo', ['yum', 'install', '-y', 'mysql-server']);
  } else {
    error('无法识别包管理器。请手动安装 MySQL。');
    return false;
  }

  // 启动 MySQL 服务
  runCommand('sudo', ['systemctl', 'start', 'mysqld']);
  runCommand('sudo', ['systemctl', 'enable', 'mysqld']);

  // 获取临时密码并修改
  if (rootPassword) {
    log('正在设置 root 密码...');
    // MySQL 8.0 初始密码在日志中
    const tempPass = runCommand('sudo', ['grep', 'temporary password', '/var/log/mysqld.log']);
    if (tempPass.stdout) {
      const tmpPwd = tempPass.stdout.split(':').pop()?.trim();
      if (tmpPwd) {
        runCommand('mysql', ['-uroot', `-p${tmpPwd}`, '--connect-expired-password', '-e',
          `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';`]);
      }
    }
  }

  success('MySQL 安装完成');
  return true;
}

// ==================== 配置 MySQL ====================

async function configureMySQL(rootPassword) {
  log('正在配置 MySQL...');

  // 依次尝试可用凭据: .env 配置 → root + 传入密码 → root + .env 密码 → root 空密码 (新装默认)
  const candidates = [];
  const add = (user, pass) => {
    if (!user) return;
    const key = `${user}\u0000${pass || ''}`;
    if (!candidates.some((c) => `${c.user}\u0000${c.pass}` === key)) candidates.push({ user, pass: pass || '' });
  };
  add(DB_USER, DB_PASSWORD);
  add('root', rootPassword);
  add('root', DB_PASSWORD);
  add('root', '');

  let admin = null;
  for (const c of candidates) {
    const probe = runCommand('mysql', ['-u' + c.user, ...(c.pass ? [`-p${c.pass}`] : []), '-e', 'SELECT 1']);
    if (probe.status === 0) { admin = c; break; }
  }
  if (!admin) {
    error('所有凭据都无法连接 MySQL (已尝试 .env 的 DB_USER/DB_PASSWORD 与 root 空密码)');
    error('请确认服务已启动，并检查 .env 中的数据库账号密码');
    return false;
  }
  log(`使用凭据 ${admin.user} 连接 MySQL`);

  const adminArgs = () => ['-u' + admin.user, ...(admin.pass ? [`-p${admin.pass}`] : [])];

  // 创建数据库
  const createDb = runCommand('mysql', [
    ...adminArgs(),
    '-e',
    `CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET ${DB_CHARSET} COLLATE ${DB_COLLATION};`
  ]);
  if (createDb.status !== 0) {
    error('无法创建数据库');
    if (createDb.stderr) error(createDb.stderr.substring(0, 500));
    error(`请手动执行: CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET ${DB_CHARSET};`);
    return false;
  }
  success(`数据库 ${DB_NAME} 就绪`);

  // 依次执行全部迁移 SQL (001 → 002 → ... 按文件名排序)
  // 迁移脚本自身幂等 (IF NOT EXISTS / 条件判断)，可安全重复执行
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const migrationFiles = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  if (migrationFiles.length === 0) {
    error('未找到迁移文件 (migrations/*.sql)');
    return false;
  }

  for (const file of migrationFiles) {
    log(`正在执行迁移 ${file} ...`);
    const migrate = spawnSync('mysql', [...adminArgs(), DB_NAME], {
      stdio: ['pipe', 'pipe', 'pipe'],
      input: fs.readFileSync(path.join(migrationsDir, file)),
      encoding: 'utf8',
    });

    // 非 0 一律视为失败: 旧实现把"认证失败/表不存在/语法错误"也当成
    // "可能只是警告"继续跑，最后照样打印"配置完成"，迁移其实一条都没落地
    if (migrate.status !== 0) {
      error(`迁移 ${file} 失败`);
      if (migrate.stderr) error(migrate.stderr.replace(/Using a password[^\n]*\n?/g, '').substring(0, 800));
      return false;
    }
    success(`迁移 ${file} 完成`);
  }

  // 应用账号若不同于管理员账号，需授予该库权限 (否则后端启动即 Access denied)
  if (DB_USER !== admin.user) {
    const grant = runCommand('mysql', [
      ...adminArgs(),
      '-e',
      `CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
       GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
       FLUSH PRIVILEGES;`,
    ]);
    if (grant.status !== 0) {
      warn(`无法自动授权给应用账号 ${DB_USER}，请手动 GRANT`);
      if (grant.stderr) warn(grant.stderr.substring(0, 300));
    } else {
      success(`已授权 ${DB_USER}@localhost 访问 ${DB_NAME}`);
    }
  }

  return true;
}

// ==================== 交互式输入 ====================

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ==================== 主流程 ====================

async function main() {
  console.log('\n========================================');
  console.log('  WildAPI - MySQL 自动安装配置工具');
  console.log('========================================\n');

  // 解析参数
  const args = process.argv.slice(2);
  const forceReinstall = args.includes('--force');
  const rootPwdArg = args.find(a => a.startsWith('--root-password='));
  const packagePathArg = args.find(a => a.startsWith('--package='));
  let rootPassword = rootPwdArg ? rootPwdArg.split('=')[1] : process.env.MYSQL_ROOT_PASSWORD || '';

  // 检测 MySQL
  const detection = await detectMySQL();

  if (detection.installed && !forceReinstall) {
    success('MySQL 已安装，跳过安装步骤');
    const configured = await configureMySQL(rootPassword);
    if (!configured) {
      error('\n✗ MySQL 配置失败，请按上面的错误处理后重试');
      process.exit(1);
    }
    success('\n✓ MySQL 配置完成！可以使用 npm run dev 启动服务');
    return;
  }

  if (forceReinstall) {
    warn('--force 模式: 将跳过检测，直接尝试安装');
  }

  // 询问 root 密码
  if (!rootPassword) {
    rootPassword = await askUser('请设置 MySQL root 密码 (留空使用默认: wildapi_root_2024): ');
    if (!rootPassword) rootPassword = 'wildapi_root_2024';
  }

  log(`目标数据库: ${DB_NAME}`);
  log(`字符集: ${DB_CHARSET}`);
  log('');

  // 按操作系统执行安装
  let installSuccess = false;

  if (isWindows()) {
    const packagePath = packagePathArg ? packagePathArg.split('=')[1] : null;
    installSuccess = await installWindows(packagePath, rootPassword);
  } else if (isLinux()) {
    installSuccess = await installLinux(rootPassword);
  } else {
    error(`不支持的操作系统: ${os.platform()}`);
    process.exit(1);
  }

  if (!installSuccess) {
    error('MySQL 安装失败，请手动安装后再运行此脚本');
    process.exit(1);
  }

  // 等待 MySQL 服务启动
  log('等待 MySQL 服务启动...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // 配置数据库
  const configured = await configureMySQL(rootPassword);
  if (!configured) {
    error('\n✗ 数据库初始化失败，请按上面的错误提示处理');
    process.exit(1);
  }

  // 生成 .env 配置提示
  console.log('\n\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  MySQL 安装配置完成!\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m\n');
  console.log('请在 .env 文件中确认以下配置:');
  console.log(`  DB_HOST=localhost`);
  console.log(`  DB_PORT=${DB_PORT}`);
  console.log(`  DB_USER=${DB_USER}`);
  console.log(`  DB_PASSWORD=${rootPassword}`);
  console.log(`  DB_NAME=${DB_NAME}`);
  console.log('');
  console.log('启动服务: npm run dev');
  console.log('');
}

main().catch((err) => {
  error(`安装过程出错: ${err.message}`);
  process.exit(1);
});
