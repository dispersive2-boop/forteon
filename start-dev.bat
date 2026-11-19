@echo off
chcp 65001 >nul
title ForteOn dev
setlocal

set WEB_PORT=8080
set API_PORT=8081
if not "%FORTEON_WEB_PORT%"=="" set WEB_PORT=%FORTEON_WEB_PORT%
if not "%FORTEON_API_PORT%"=="" set API_PORT=%FORTEON_API_PORT%

echo ==================================================
echo  ForteOn  ^|  web :%WEB_PORT%  ^|  api :%API_PORT%
echo  (AI-агент на :3000 и Caddy на :80/:443 не затрагиваются)
echo ==================================================

if not exist "%~dp0.env" copy "%~dp0.env.example" "%~dp0.env" >nul
if not exist "%~dp0backend\data" mkdir "%~dp0backend\data"

set NEXT_PUBLIC_API_URL=http://127.0.0.1:%API_PORT%

start "ForteOn API :%API_PORT%" cmd /k "cd /d %~dp0backend && python -m uvicorn app.main:app --host 127.0.0.1 --port %API_PORT%"
timeout /t 4 /nobreak >nul
REM -H 127.0.0.1 обязателен: иначе Next слушает все интерфейсы и порт открыт в интернет в обход Caddy
start "ForteOn Web :%WEB_PORT%" cmd /k "cd /d %~dp0frontend && npx.cmd next dev -H 127.0.0.1 -p %WEB_PORT%"

timeout /t 7 /nobreak >nul
start "" http://127.0.0.1:%WEB_PORT%/login

echo.
echo Логины: manager@forteon.local , admin@forteon.local
echo Пароли: backend\data\bootstrap-credentials.txt (в консоль не выводятся)
endlocal
