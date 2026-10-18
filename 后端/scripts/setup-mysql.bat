@echo off
chcp 65001 >nul
title WildAPI - MySQL 自动安装配置
echo.
echo ========================================
echo   WildAPI - MySQL 自动安装配置 (Windows)
echo ========================================
echo.

cd /d "%~dp0\.."

:: 检查 Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

:: 运行安装脚本
node scripts/setup-mysql.js %*

pause
