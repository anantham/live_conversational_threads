$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $repoRoot "lct_python_backend"
$backendPort = if ($env:BACKEND_PORT) { $env:BACKEND_PORT } else { "43180" }
$frontendPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "43173" }
$env:BACKEND_PORT = $backendPort
$env:FRONTEND_PORT = $frontendPort
$env:FRONTEND_URL = if ($env:FRONTEND_URL) { $env:FRONTEND_URL } else { "http://localhost:$frontendPort" }
Set-Content -Path (Join-Path $repoRoot ".backend-port") -Value $backendPort
Set-Content -Path (Join-Path $repoRoot ".frontend-port") -Value $frontendPort

# Start LCT Backend
Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$backendPath`" && ..\.venv\Scripts\python -m uvicorn backend:app --host 0.0.0.0 --port $backendPort --reload" -WindowStyle Minimized

# Start IndrasNet
$indrasPath = "C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet"
Remove-Item -Path "$indrasPath\logs\web_server.log*" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$indrasPath`" && python start_server.py" -WindowStyle Minimized

Write-Host "Services starting with backend=$backendPort frontend=$frontendPort"
