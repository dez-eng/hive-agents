@echo off
chcp 65001 >nul
title LLM Failover Proxy

REM 切到脚本自身所在目录，不写死盘符
cd /d "%~dp0"

echo ============================================
echo   LLM Failover Proxy
echo   云端优先 - 断网自动回退本地 Ollama
echo   状态查看: http://127.0.0.1:11500/__status
echo ============================================
echo.

python failover_proxy.py

echo.
echo 代理已退出。按任意键关闭窗口。
pause >nul