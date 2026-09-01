param(
    [ValidateSet("Probe", "RunComponent")]
    [string]$Action = "RunComponent",
    [ValidateSet("Collector", "Prometheus", "Tempo", "Grafana")]
    [string]$Component,
    [Guid]$RunId = [Guid]::NewGuid(),
    [string]$RuntimeRoot = "C:\ProgramData\LCT\observability",
    [ValidateRange(30, 600)]
    [int]$StartupTimeoutSeconds = 300,
    [ValidateRange(2, 300)]
    [int]$HealthCheckIntervalSeconds = 10,
    [ValidateRange(2, 60)]
    [int]$HealthFailureThreshold = 6,
    [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LogRoot = Join-Path $RepoRoot "logs\observability"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$LifecycleLog = if ($Action -eq "Probe") {
    Join-Path $LogRoot "task-entry-probe.jsonl"
} else {
    $componentName = if ($Component) { $Component.ToLowerInvariant() } else { "unknown" }
    Join-Path $LogRoot ("{0}.task.jsonl" -f $componentName)
}

function Write-TaskEvent {
    param([hashtable]$Fields)

    $record = [ordered]@{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        event = $Fields.event
        action = $Action
        component = $Component
        run_id = $RunId.ToString()
        wrapper_pid = $PID
    }
    foreach ($key in $Fields.Keys) {
        if (-not $record.Contains($key)) {
            $record[$key] = $Fields[$key]
        }
    }
    Add-Content -LiteralPath $LifecycleLog -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

Write-TaskEvent @{ event = "entry" }
Write-TaskEvent @{
    event = "context"
    user_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    local_app_data = $env:LOCALAPPDATA
    user_profile = $env:USERPROFILE
    runtime_root = $RuntimeRoot
}

if ($Action -eq "Probe") {
    try {
        $collectorInstall = Join-Path $RuntimeRoot "bin\collector-0.159.0"
        $collectorMarker = Join-Path $collectorInstall ".installed-sha256"
        $collectorExecutable = Join-Path $collectorInstall "otelcol-contrib.exe"
        $markerError = $null
        $executableError = $null
        try {
            Get-Item -LiteralPath $collectorMarker -Force -ErrorAction Stop | Out-Null
        } catch {
            $markerError = "{0}: {1} (0x{2:X8})" -f $_.Exception.GetType().FullName, $_.Exception.Message, $_.Exception.HResult
        }
        try {
            Get-Item -LiteralPath $collectorExecutable -Force -ErrorAction Stop | Out-Null
        } catch {
            $executableError = "{0}: {1} (0x{2:X8})" -f $_.Exception.GetType().FullName, $_.Exception.Message, $_.Exception.HResult
        }
        Write-TaskEvent @{
            event = "runtime_check"
            runtime_root_exists = Test-Path -LiteralPath $RuntimeRoot -PathType Container
            collector_install = $collectorInstall
            collector_marker_exists = $null -eq $markerError
            collector_executable_exists = $null -eq $executableError
            collector_marker_error = $markerError
            collector_executable_error = $executableError
        }
        Write-TaskEvent @{ event = "probe_complete"; exit_code = 0 }
        return
    } catch {
        Write-TaskEvent @{
            event = "probe_failure"
            exception_type = $_.Exception.GetType().FullName
            error = $_.Exception.Message
            exit_code = 1
        }
        throw
    }
}

$Launcher = Join-Path $PSScriptRoot "start_observability.ps1"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$TaskOutputLog = Join-Path $LogRoot ("{0}.task-output.log" -f $Component.ToLowerInvariant())
$RestartDelaysSeconds = @(2, 5, 10, 30, 60)
$StableRunResetSeconds = 300

try {
    if (-not $Component) {
        throw "-Component is required when -Action RunComponent is used"
    }
    if (-not $SkipDownload) {
        throw "-SkipDownload is required for a supervised component task"
    }
    if (-not (Test-Path -LiteralPath $Launcher)) {
        throw "Observability launcher is missing: $Launcher"
    }

    $restartAttempt = 0
    while ($true) {
        $attempt = $restartAttempt + 1
        $childStartedAt = [DateTimeOffset]::UtcNow
        Write-TaskEvent @{
            event = "child_start"
            attempt = $attempt
            output_log = $TaskOutputLog
        }
        $exitCode = $null
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # Windows PowerShell 5 wraps native child stderr as NativeCommandError.
            # The child owns its exit code, so capture output without converting it.
            $ErrorActionPreference = "Continue"
            & $PowerShellExe `
                -NoProfile `
                -ExecutionPolicy Bypass `
                -File $Launcher `
                -Action RunComponent `
                -Component $Component `
                -RuntimeRoot $RuntimeRoot `
                -StartupTimeoutSeconds $StartupTimeoutSeconds `
                -HealthCheckIntervalSeconds $HealthCheckIntervalSeconds `
                -HealthFailureThreshold $HealthFailureThreshold `
                -SkipDownload *>> $TaskOutputLog
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }

        if ($null -eq $exitCode) {
            $exitCode = 1
        }
        $runSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $childStartedAt).TotalSeconds, 3)
        Write-TaskEvent @{
            event = "child_exit"
            attempt = $attempt
            exit_code = [int]$exitCode
            run_seconds = $runSeconds
        }
        if ($runSeconds -ge $StableRunResetSeconds) {
            $restartAttempt = 0
        }
        $delayIndex = [Math]::Min($restartAttempt, $RestartDelaysSeconds.Count - 1)
        $restartDelay = $RestartDelaysSeconds[$delayIndex]
        Write-TaskEvent @{
            event = "restart_scheduled"
            attempt = $attempt
            next_attempt = $attempt + 1
            exit_code = [int]$exitCode
            delay_seconds = $restartDelay
        }
        Start-Sleep -Seconds $restartDelay
        $restartAttempt = [Math]::Min($restartAttempt + 1, $RestartDelaysSeconds.Count - 1)
    }
} catch {
    Write-TaskEvent @{
        event = "wrapper_failure"
        exception_type = $_.Exception.GetType().FullName
        error = $_.Exception.Message
        exit_code = 1
    }
    throw
}
