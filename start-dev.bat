@echo off
rem 启动 excalidraw-app 开发服务器（双击运行或终端执行）
cd /d %~dp0
yarn start --port 8501 --strictPort
pause
