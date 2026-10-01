param(
    [Parameter(Mandatory = $true)][string]$BuildDirectory,
    [Parameter(Mandatory = $true)][string]$ViteCli,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9.-]+$')][string]$TailnetHostname,
    [string]$ReleaseDirectory = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'LCTTailnetViewer'),
    [string]$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source,
    [ValidateRange(1024, 65535)][int]$Port = 43191
)

$ErrorActionPreference = 'Stop'
$taskName = 'LCT-Tailnet-Viewer'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$build = (Resolve-Path -LiteralPath $BuildDirectory).ProviderPath
$runtime = (& $NodeExecutable -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not resolve the installed Node runtime: $NodeExecutable" }
$node = (Resolve-Path -LiteralPath $runtime).ProviderPath
$vite = (Resolve-Path -LiteralPath $ViteCli).ProviderPath
$viteModule = Join-Path (Split-Path -Parent (Split-Path -Parent $vite)) 'dist\node\index.js'
if (-not (Test-Path -LiteralPath $viteModule)) { throw "Installed Vite module missing: $viteModule" }
if (-not (Test-Path -LiteralPath (Join-Path $build 'index.html'))) { throw "Build has no index.html: $build" }

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $owner = $existing.Principal.UserId
    $ownerSid = if ($owner -like 'S-1-*') { $owner } else { ([System.Security.Principal.NTAccount]::new($owner).Translate([System.Security.Principal.SecurityIdentifier])).Value }
    if ($ownerSid -ne $identity.User.Value) { throw "Refusing to replace another user's task: $taskName" }
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is still occupied; inspect its owner rather than killing an unrelated process."
}

New-Item -ItemType Directory -Path $ReleaseDirectory -Force | Out-Null
$release = (Resolve-Path -LiteralPath $ReleaseDirectory).ProviderPath
$dist = Join-Path $release 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Get-ChildItem -LiteralPath $build -Force | Copy-Item -Destination $dist -Recurse -Force
$launcher = Join-Path $release 'serve-viewer.mjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'serve-viewer.mjs') -Destination $launcher -Force

$arguments = '"{0}" "{1}" "{2}" "{3}" {4}' -f $launcher, $release, $viteModule, $TailnetHostname, $Port
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $release
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger, $recovery) -Principal $principal -Settings $settings -Description 'Loopback LCT viewer for the existing Tailnet-only route.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$started = Get-Date
do {
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    Write-Output "Waiting for scheduled viewer: ${elapsed}s elapsed; time remaining unknown."
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
        $running = (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'
        if ($running -and $response.StatusCode -eq 200 -and $response.Content -match '<div id="root">') {
            Write-Output "Scheduled viewer is running. Check the actual Tailnet URL and rendered conversation before reporting deployment complete."
            return
        }
    } catch { }
} while ($elapsed -lt 30)
$result = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
throw "Scheduled viewer did not become ready (task result $result). Task Scheduler may not see $release; inspect its events and $release\viewer.log."
