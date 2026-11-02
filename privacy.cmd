@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "dist\cli.js" (
  echo [privacy] dist\cli.js 不存在，先构建...
  call npm run build
  if errorlevel 1 (
    echo [privacy] 构建失败
    pause
    exit /b 1
  )
)
node dist\cli.js privacy
