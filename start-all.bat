@echo off
chcp 65001 >nul
title CTF Local Stack

REM 所有路径都相对本脚本所在目录，不写死盘符
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo ============================================================
echo   CTF 本地推理栈 - 一键启动
echo   1. Ollama 服务（本地模型）
echo   2. Failover 代理（云端优先 / 断网回退）
echo ============================================================
echo   根目录: %ROOT%
echo.

echo [1/2] 启动 Ollama 服务...
start "Ollama-Serve" cmd /c ""%ROOT%\ctf-workspace\start-ollama.bat""
timeout /t 6 /nobreak >nul

echo [2/2] 启动 Failover 代理...
start "Failover-Proxy" cmd /c ""%ROOT%\llm-failover\start-proxy.bat""
timeout /t 4 /nobreak >nul

echo.
echo ------------------------------------------------------------
echo 当前状态:
echo ------------------------------------------------------------
curl -s -m 5 http://127.0.0.1:11500/__status
echo.
echo ------------------------------------------------------------
echo Ollama:
curl -s -m 5 http://127.0.0.1:11434/api/version
echo.
echo ------------------------------------------------------------
echo.
echo 两个服务窗口请保持开启（可最小化，不要关闭）。
echo 把客户端 base_url 指向 http://127.0.0.1:11500 即可走回退代理
echo.
pause