@echo off
rem hive 启动器：保证在真终端里跑，这样启动时才会出现「正常 / 隐私窗口」的选择。
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\" (
  echo [hive] 还没安装依赖：先跑 npm install
  exit /b 1
)

if not exist "dist\cli.js" (
  echo [hive] 还没有构建，正在 npm run build ...
  call npm run build
  if errorlevel 1 (
    echo [hive] 构建失败
    exit /b 1
  )
)

node dist\cli.js %*
endlocal
