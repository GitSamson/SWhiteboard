@echo off
rem Start the excalidraw-app dev server (double-click or run from terminal)
cd /d %~dp0
yarn start --port 8501 --strictPort
pause
