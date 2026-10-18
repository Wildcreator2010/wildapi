@echo off
chcp 65001 >nul
title WildAPI - 完全卸载 (Windows)
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: 读取部署标识 (与 deploy.bat 同源): 改过 PREFIX/DATA_DIR 的部署若继续用硬编码名字，
:: 会打印"卸载完成"却一个容器一个文件都没删
set "PREFIX=wildapi"
set "DATA_DIR=C:\opt\WildAPI"
for /f "tokens=2 delims==" %%a in ('findstr /b "PREFIX=" .env 2^>nul') do set "PREFIX=%%a"
for /f "tokens=2 delims==" %%a in ('findstr /b "DATA_DIR=" .env 2^>nul') do set "DATA_DIR=%%a"
set "DATA_DIR=%DATA_DIR:/=\%"
if "%DATA_DIR:~0,2%"=="\\" set "DATA_DIR=C:\opt\WildAPI"
if not exist "%DATA_DIR:~0,2%\" set "DATA_DIR=C:\opt\WildAPI"

echo.
echo ========================================
echo   WildAPI - 完全卸载
echo ========================================
echo.
echo 此操作将删除:
echo   - 容器与镜像前缀: !PREFIX!
echo   - 数据目录:       !DATA_DIR!
echo   - Docker 网络:    !PREFIX!-network
echo.

set /p confirm=确认卸载? 输入 YES 继续:
if /i not "%confirm%"=="YES" (
    echo 卸载已取消
    pause
    exit /b 0
)

echo.
echo [1/5] 停止并删除容器...
docker compose down --remove-orphans --volumes 2>nul

echo [2/5] 删除镜像...
docker rmi %PREFIX%-backend:latest 2>nul
docker rmi %PREFIX%-frontend:latest 2>nul

echo [3/5] 删除网络...
docker network rm %PREFIX%-network 2>nul

echo [4/5] 删除数据目录...
if not exist "%DATA_DIR%\mysql" if not exist "%DATA_DIR%\redis" if not exist "%DATA_DIR%\backups" (
    echo   未发现 !DATA_DIR! 下的数据目录，跳过
) else (
    rmdir /s /q "%DATA_DIR%\mysql" 2>nul
    rmdir /s /q "%DATA_DIR%\redis" 2>nul
    rmdir /s /q "%DATA_DIR%\backups" 2>nul
    rmdir /s /q "%DATA_DIR%\logs" 2>nul
)

echo [5/5] 清理构建缓存...
docker builder prune -f 2>nul

echo.
echo ========================================
echo   卸载完成
echo ========================================
echo.
pause
