@echo off
chcp 65001 >nul
title WildAPI - 一键部署 (Windows)
setlocal enabledelayedexpansion

echo.
echo ========================================
echo   WildAPI - AI API 中转站 一键部署
echo ========================================
echo.

:: 检测 Docker
where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Docker Desktop
    echo   下载: https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)

cd /d "%~dp0"

:: 检查 .env
if not exist .env (
    echo [提示] 未找到 .env，从 .env.example 复制...
    copy /y .env.example .env >nul
    echo.
    echo ========================================
    echo   请先编辑 docker\.env 文件!
    echo   请检查 docker\.env 配置与服务器环境是否一致
    echo ========================================
    echo.
    pause
)

:: 从 .env 读取部署标识 (默认 PREFIX=wildapi, DATA_DIR=C:\opt\WildAPI)
set "PREFIX=wildapi"
set "DATA_DIR=C:\opt\WildAPI"
for /f "tokens=2 delims==" %%a in ('findstr /b "PREFIX=" .env 2^>nul') do set "PREFIX=%%a"
for /f "tokens=2 delims==" %%a in ('findstr /b "DATA_DIR=" .env 2^>nul') do set "DATA_DIR=%%a"
:: Linux 风格路径转 Windows
set "DATA_DIR=%DATA_DIR:/=\%"
if "%DATA_DIR:~0,1%"=="" set "DATA_DIR=C:\opt\WildAPI"
if not exist "%DATA_DIR:~0,2%\" set "DATA_DIR=C:\opt\WildAPI"
echo [*] 部署标识: PREFIX=%PREFIX%, DATA_DIR=%DATA_DIR%

:: 创建数据目录
echo [*] 创建数据目录...
if not exist "%DATA_DIR%\mysql"      mkdir "%DATA_DIR%\mysql"
if not exist "%DATA_DIR%\redis"      mkdir "%DATA_DIR%\redis"
if not exist "%DATA_DIR%\backups"    mkdir "%DATA_DIR%\backups"
if not exist "%DATA_DIR%\logs"       mkdir "%DATA_DIR%\logs"

:: 迁移脚本由 compose 直接挂载仓库内的 ..\migrations，不再复制副本

:: 同步 nginx.conf 到前端构建上下文
copy /y "nginx.conf" "..\..\前端\nginx.conf" >nul 2>nul

echo [1/4] 停止旧容器...
docker compose down --remove-orphans 2>nul

echo [2/4] 构建镜像...
docker compose build --no-cache 2>nul
if %ERRORLEVEL% neq 0 (
    echo [警告] compose 构建失败，切换到传统 docker build...
    set DOCKER_BUILDKIT=0
    docker build -t %PREFIX%-backend:latest -f Dockerfile.backend ..
    if !ERRORLEVEL! neq 0 ( echo [错误] 后端镜像构建失败 & pause & exit /b 1 )
    docker build -t %PREFIX%-frontend:latest -f Dockerfile.frontend ..\..\前端
    if !ERRORLEVEL! neq 0 ( echo [错误] 前端镜像构建失败 & pause & exit /b 1 )
)

echo [3/4] 启动服务...
docker compose up -d --no-build

echo [4/4] 执行数据库迁移 (幂等)...

:: 等 MySQL 健康检查通过，固定 15 秒在首轮部署常不够 (届时迁移全失败却照样打印部署完成)
set "TRIES=0"
:wait_mysql
set /a TRIES+=1
set "MYSQL_STATE="
for /f "usebackq delims=" %%s in (`docker inspect --format "{{.State.Health.Status}}" %PREFIX%-mysql 2^>nul`) do set "MYSQL_STATE=%%s"
if "%MYSQL_STATE%"=="healthy" goto mysql_ready
if %TRIES% geq 60 (
    echo [错误] MySQL 在 120 秒内未就绪，迁移中止
    echo   docker logs %PREFIX%-mysql
    pause
    exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait_mysql
:mysql_ready
echo   MySQL 已就绪，开始迁移...

:: 从宿主机用 stdin 把文件喂进容器: 旧写法把 Windows 路径拼成容器内路径，
:: 读到的其实是不存在的文件，错误又被 nul 吞掉，8 个文件一律"跳过"
set "MIGRATE_FAILED=0"
for %%f in ("..\migrations\*.sql") do (
    docker exec -i %PREFIX%-mysql sh -c "mysql -uroot -p$MYSQL_ROOT_PASSWORD" < "%%f"
    if !ERRORLEVEL! equ 0 (
        echo   已应用: %%~nxf
    ) else (
        echo   [错误] 迁移失败: %%~nxf
        set "MIGRATE_FAILED=1"
    )
)
if "%MIGRATE_FAILED%"=="1" (
    echo [错误] 数据库迁移未全部成功，服务不可用
    pause
    exit /b 1
)

echo.
echo ========================================
echo   服务状态
echo ========================================
docker compose ps

echo.
echo ========================================
echo   部署完成!
echo ========================================
echo.
echo   前端: http://localhost
echo   API:  http://localhost:3000/v1/chat/completions
echo.
echo   数据目录: %DATA_DIR%\
echo.
echo   管理命令:
echo     查看日志: cd docker ^&^& docker compose logs -f
echo     停止服务: cd docker ^&^& docker compose down
echo     完全卸载: cd docker ^&^& uninstall.bat
echo.
pause
