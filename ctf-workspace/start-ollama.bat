@echo off
chcp 65001 >nul
title Ollama - CTF Local LLM

REM ============================================
REM  CTF 专项本地模型启动脚本
REM  模型: qwen3:30b-a3b-thinking-2507-q4_K_M
REM  双击运行即可，窗口可最小化但不要关闭
REM
REM  路径都可用环境变量覆盖，不写死盘符：
REM    OLLAMA_HOME     ollama.exe 所在目录（默认走 PATH）
REM    OLLAMA_MODELS   模型仓库目录（默认 ollama 自己的默认位置）
REM ============================================

if defined OLLAMA_MODELS (
  echo   模型目录: %OLLAMA_MODELS% （来自环境变量）
) else (
  echo   模型目录: 未设置 OLLAMA_MODELS，使用 ollama 默认位置
)

set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_TYPE=q8_0
set OLLAMA_NUM_PARALLEL=1
set OLLAMA_MAX_LOADED_MODELS=1
set OLLAMA_KEEP_ALIVE=30m
set OLLAMA_HOST=127.0.0.1:11434

if defined OLLAMA_HOME cd /d "%OLLAMA_HOME%"

echo.
echo  模型目录 : %OLLAMA_MODELS%
echo  服务地址 : http://%OLLAMA_HOST%
echo  FlashAttn: %OLLAMA_FLASH_ATTENTION%   KV量化: %OLLAMA_KV_CACHE_TYPE%
echo.
echo  可用模型:
ollama.exe list
echo.
echo  正在启动服务... 按 Ctrl+C 停止
echo.

ollama.exe serve