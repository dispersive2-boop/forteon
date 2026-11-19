# ForteOn · локальный запуск (Windows)
# Порты: web 8080, api 8081 — не конфликтуют с AI-агентом (3000) и Caddy (80/443).

$ErrorActionPreference = "Stop"
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend  = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

$webPort = if ($env:FORTEON_WEB_PORT) { $env:FORTEON_WEB_PORT } else { "8080" }
$apiPort = if ($env:FORTEON_API_PORT) { $env:FORTEON_API_PORT } else { "8081" }

Write-Host "=== ForteOn dev ===" -ForegroundColor Cyan
Write-Host "Web: http://127.0.0.1:$webPort"
Write-Host "API: http://127.0.0.1:$apiPort  (docs: /api/docs)"
Write-Host ""

foreach ($pair in @(@($webPort, "web"), @($apiPort, "api"))) {
    $port = $pair[0]
    $busy = Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue
    if ($busy) {
        Write-Host "Порт $port занят (PID $($busy[0].OwningProcess)). Освободите его или задайте другой через FORTEON_$($pair[1].ToUpper())_PORT." -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path (Join-Path $backend "data"))) {
    New-Item -ItemType Directory -Path (Join-Path $backend "data") | Out-Null
}
if (-not (Test-Path (Join-Path $root ".env"))) {
    Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
    Write-Host "Создан .env из .env.example" -ForegroundColor Yellow
}

Write-Host "Проверка зависимостей Python..." -ForegroundColor DarkGray
python -c "import fastapi, sqlalchemy, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Устанавливаю зависимости backend..." -ForegroundColor Yellow
    python -m pip install -q -r (Join-Path $backend "requirements.txt")
}

if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Host "Устанавливаю зависимости frontend..." -ForegroundColor Yellow
    Push-Location $frontend
    cmd /c "npm.cmd install --no-audit --no-fund"
    Pop-Location
}

# Same-origin схема: браузер идёт на :8080, API живёт на :8081.
# Переменная нужна только для локального открытия в браузере: если страница
# открыта с домена, src/lib/api.ts игнорирует её и работает через тот же origin.
$env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:$apiPort"

Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c title ForteOn API :$apiPort && python -m uvicorn app.main:app --host 127.0.0.1 --port $apiPort" `
    -WorkingDirectory $backend

Start-Sleep -Seconds 3

# -H 127.0.0.1 обязателен: без него Next слушает все интерфейсы и порт 8080
# оказывается открыт в интернет в обход Caddy (без TLS и без заголовков).
Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c title ForteOn Web :$webPort && npx.cmd next dev -H 127.0.0.1 -p $webPort" `
    -WorkingDirectory $frontend

Write-Host ""
Write-Host "Откройте http://127.0.0.1:$webPort/login" -ForegroundColor Green
Write-Host "Логины: manager@forteon.local , admin@forteon.local"
Write-Host "Пароли: backend\data\bootstrap-credentials.txt (не выводится в консоль)"
