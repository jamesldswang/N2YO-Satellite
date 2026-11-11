@echo off
rem Start the server in this window and open the page. Close the window to stop.
rem Uses node.exe next to this file (release zip) if present, else node on PATH.
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"

if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  start "" notepad ".env"
)

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8000"
"%NODE%" server.js
if errorlevel 1 pause
