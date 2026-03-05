# Start LCT Backend
$backendPath = "C:\Users\adity\Documents\Ongoing Local\live_conversational_threads\lct_python_backend"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$backendPath`" && .venv\Scripts\python -m uvicorn backend:app --host 0.0.0.0 --port 8080 --reload" -WindowStyle Minimized

# Start IndrasNet
$indrasPath = "C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet"
Remove-Item -Path "$indrasPath\logs\web_server.log*" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$indrasPath`" && python start_server.py" -WindowStyle Minimized

Write-Host "Services starting..."
