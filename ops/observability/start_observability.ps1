param(
    [ValidateSet("Start", "Stop", "Status", "Prepare", "RunComponent")]
    [string]$Action = "Start",
    [ValidateSet("Collector", "Prometheus", "Tempo", "Grafana")]
    [string]$Component,
    [string]$RuntimeRoot,
    [ValidateRange(30, 600)]
    [int]$StartupTimeoutSeconds = 90,
    [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = "C:\ProgramData\LCT\observability"
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)

$Versions = @{
    Collector = "0.159.0"
    Prometheus = "3.13.0"
    Tempo = "2.10.7"
    Grafana = "13.2.0"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallRoot = Join-Path $RuntimeRoot "bin"
$DownloadRoot = Join-Path $RuntimeRoot "downloads"
$DataRoot = Join-Path $RuntimeRoot "data"
$PidRoot = Join-Path $RuntimeRoot "pids"
$LogRoot = Join-Path $RepoRoot "logs\observability"
$CollectorConfig = Join-Path $PSScriptRoot "otel-collector.yml"
$PrometheusConfig = Join-Path $PSScriptRoot "prometheus.yml"
$TempoConfig = Join-Path $PSScriptRoot "tempo.yml"
$GrafanaProvisioning = Join-Path $PSScriptRoot "grafana\provisioning"

$Components = [ordered]@{
    Collector = @{
        Version = $Versions.Collector
        Archive = "otelcol-contrib_$($Versions.Collector)_windows_amd64.tar.gz"
        Url = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$($Versions.Collector)/otelcol-contrib_$($Versions.Collector)_windows_amd64.tar.gz"
        ChecksumUrl = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$($Versions.Collector)/otelcol-contrib_$($Versions.Collector)_windows_amd64.tar.gz.sha256"
        Executable = "otelcol-contrib.exe"
        Port = 13133
        ReadyUrl = "http://127.0.0.1:13133/"
    }
    Prometheus = @{
        Version = $Versions.Prometheus
        Archive = "prometheus-$($Versions.Prometheus).windows-amd64.zip"
        Url = "https://github.com/prometheus/prometheus/releases/download/v$($Versions.Prometheus)/prometheus-$($Versions.Prometheus).windows-amd64.zip"
        ChecksumUrl = "https://github.com/prometheus/prometheus/releases/download/v$($Versions.Prometheus)/sha256sums.txt"
        Executable = "prometheus.exe"
        Port = 9090
        ReadyUrl = "http://127.0.0.1:9090/-/ready"
    }
    Tempo = @{
        Version = $Versions.Tempo
        Archive = "tempo_$($Versions.Tempo)_windows_amd64.tar.gz"
        Url = "https://github.com/grafana/tempo/releases/download/v$($Versions.Tempo)/tempo_$($Versions.Tempo)_windows_amd64.tar.gz"
        ChecksumUrl = "https://github.com/grafana/tempo/releases/download/v$($Versions.Tempo)/SHA256SUMS"
        Executable = "tempo.exe"
        Port = 3200
        ReadyUrl = "http://127.0.0.1:3200/ready"
    }
    Grafana = @{
        Version = $Versions.Grafana
        Archive = "grafana_$($Versions.Grafana)_32077357341_windows_amd64.tar.gz"
        Url = "https://dl.grafana.com/grafana/release/$($Versions.Grafana)/grafana_$($Versions.Grafana)_32077357341_windows_amd64.tar.gz"
        Checksum = "3359fa6fffb1fdf12f5424b3f1b5929b3d97a0db6b66d39087dd2cf83e1780ba"
        Executable = "grafana-server.exe"
        Port = 3000
        ReadyUrl = "http://127.0.0.1:3000/api/health"
    }
}

function Assert-UnderRuntimeRoot {
    param([string]$Path)

    $runtimeFull = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
    $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd("\") + "\"
    if (-not $pathFull.StartsWith($runtimeFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem operation outside observability runtime root: $Path"
    }
}

function Get-InstallDirectory {
    param([string]$Name, [hashtable]$Component)
    return Join-Path $InstallRoot ("{0}-{1}" -f $Name.ToLowerInvariant(), $Component.Version)
}

function Get-ExpectedHash {
    param([hashtable]$Component)

    if ($Component.Checksum) {
        return $Component.Checksum.ToLowerInvariant()
    }

    $checksumContent = (Invoke-WebRequest -UseBasicParsing -Uri $Component.ChecksumUrl).Content
    $checksumText = if ($checksumContent -is [byte[]]) {
        [Text.Encoding]::UTF8.GetString($checksumContent)
    } else {
        [string]$checksumContent
    }
    $escapedName = [regex]::Escape($Component.Archive)
    $match = [regex]::Match($checksumText, "(?im)^([0-9a-f]{64})(?:\s+\*?$escapedName)?\s*$")
    if (-not $match.Success) {
        throw "Published checksum did not contain $($Component.Archive)"
    }
    return $match.Groups[1].Value.ToLowerInvariant()
}

function Install-Component {
    param([string]$Name, [hashtable]$Component)

    $installDirectory = Get-InstallDirectory -Name $Name -Component $Component
    $markerPath = Join-Path $installDirectory ".installed-sha256"
    if (Test-Path -LiteralPath $markerPath) {
        $existingExecutable = Get-ChildItem -LiteralPath $installDirectory -Filter $Component.Executable -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $existingExecutable -and $Name -eq "Grafana") {
            $existingExecutable = Get-ChildItem -LiteralPath $installDirectory -Filter "grafana.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if ($existingExecutable) {
            return $existingExecutable.FullName
        }
    }

    if ($SkipDownload) {
        throw "$Name $($Component.Version) is not installed and -SkipDownload was supplied"
    }

    New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null
    $archivePath = Join-Path $DownloadRoot $Component.Archive
    $expectedHash = Get-ExpectedHash -Component $Component
    if (Test-Path -LiteralPath $archivePath) {
        $cachedHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($cachedHash -ne $expectedHash) {
            Write-Warning "Discarding incomplete or invalid cached archive for $Name"
            Remove-Item -LiteralPath $archivePath -Force
        }
    }

    if (-not (Test-Path -LiteralPath $archivePath)) {
        Write-Host "[DOWNLOAD] $Name $($Component.Version)"
        $partialPath = "$archivePath.partial"
        $aria = Get-Command aria2c.exe -ErrorAction SilentlyContinue
        if ($aria) {
            & $aria.Source --continue=true --allow-overwrite=true --auto-file-renaming=false --file-allocation=none --max-connection-per-server=16 --split=16 --min-split-size=1M --summary-interval=10 "--dir=$DownloadRoot" "--out=$($Component.Archive).partial" $Component.Url | Out-Host
        } else {
            & curl.exe --fail --location --retry 3 --retry-delay 2 --continue-at - --output $partialPath $Component.Url | Out-Host
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to download $Name from $($Component.Url)"
        }
        Move-Item -LiteralPath $partialPath -Destination $archivePath -Force
    }

    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "$Name archive checksum mismatch: expected $expectedHash, got $actualHash"
    }

    if (Test-Path -LiteralPath $installDirectory) {
        Assert-UnderRuntimeRoot -Path $installDirectory
        Remove-Item -LiteralPath $installDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null

    Write-Host "[INSTALL] $Name $($Component.Version)"
    if ($Component.Archive.EndsWith(".zip", [StringComparison]::OrdinalIgnoreCase)) {
        Expand-Archive -LiteralPath $archivePath -DestinationPath $installDirectory -Force
    } else {
        & tar.exe -xzf $archivePath -C $installDirectory
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to extract $($Component.Archive)"
        }
    }

    $executable = Get-ChildItem -LiteralPath $installDirectory -Filter $Component.Executable -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $executable -and $Name -eq "Grafana") {
        $executable = Get-ChildItem -LiteralPath $installDirectory -Filter "grafana.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $executable) {
        throw "$Name archive did not contain $($Component.Executable)"
    }

    Set-Content -LiteralPath $markerPath -Value $actualHash -Encoding ascii
    Remove-Item -LiteralPath $archivePath -Force
    return $executable.FullName
}

function Get-ManagedProcess {
    param([string]$Name, [string]$ExpectedExecutable)

    $pidPath = Join-Path $PidRoot ("{0}.pid" -f $Name.ToLowerInvariant())
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return $null
    }

    $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($pidText -notmatch "^\d+$") {
        Remove-Item -LiteralPath $pidPath -Force
        return $null
    }

    $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item -LiteralPath $pidPath -Force
        return $null
    }

    $actualPath = $process.Path
    if (-not $actualPath -or -not $actualPath.Equals($ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name PID file points to PID $pidText owned by '$actualPath', expected '$ExpectedExecutable'. Refusing to adopt it."
    }
    return $process
}

function Assert-PortAvailable {
    param([string]$Name, [int]$Port)

    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
        $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "$Name cannot start because port $Port is already owned by PID(s) $owners. The launcher will not terminate or adopt an unknown process."
    }
}

function Invoke-WithEnvironment {
    param([hashtable]$Environment, [scriptblock]$Script)

    $previous = @{}
    foreach ($key in $Environment.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
    }
    try {
        & $Script
    } finally {
        foreach ($key in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
        }
    }
}

function Start-ManagedProcess {
    param(
        [string]$Name,
        [string]$Executable,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment = @{}
    )

    $component = $Components[$Name]
    $existing = Get-ManagedProcess -Name $Name -ExpectedExecutable $Executable
    if ($existing) {
        Write-Host "[RUNNING] $Name PID $($existing.Id)"
        return $existing
    }

    Assert-PortAvailable -Name $Name -Port $component.Port
    $stdout = Join-Path $LogRoot ("{0}.stdout.log" -f $Name.ToLowerInvariant())
    $stderr = Join-Path $LogRoot ("{0}.stderr.log" -f $Name.ToLowerInvariant())
    $startArgs = @{
        FilePath = $Executable
        ArgumentList = $Arguments
        WorkingDirectory = $WorkingDirectory
        WindowStyle = "Hidden"
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        PassThru = $true
    }

    $process = Invoke-WithEnvironment -Environment $Environment -Script { Start-Process @startArgs }
    $pidPath = Join-Path $PidRoot ("{0}.pid" -f $Name.ToLowerInvariant())
    Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
    Write-Host "[START] $Name PID $($process.Id)"
    return $process
}

function Wait-HttpReady {
    param([string]$Name, [string]$Uri, [int]$TimeoutSeconds = 90)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                Write-Host "[READY] $Name at $Uri"
                return
            }
            $lastError = "HTTP $($response.StatusCode)"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    $stderr = Join-Path $LogRoot ("{0}.stderr.log" -f $Name.ToLowerInvariant())
    $tail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 30) -join [Environment]::NewLine } else { "(no stderr log)" }
    $message = "$Name did not become ready at $Uri within $TimeoutSeconds seconds. Last probe: $lastError"
    throw ($message + [Environment]::NewLine + "Recent stderr:" + [Environment]::NewLine + $tail)
}

function Stop-Component {
    param([string]$Name, [string]$Executable)

    $process = Get-ManagedProcess -Name $Name -ExpectedExecutable $Executable
    if (-not $process) {
        Write-Host "[STOPPED] $Name is not running"
        return
    }

    Stop-Process -Id $process.Id
    try {
        Wait-Process -Id $process.Id -Timeout 20 -ErrorAction Stop
    } catch {
        $remaining = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if ($remaining) {
            Write-Warning "$Name PID $($process.Id) did not stop within 20 seconds; leaving it running"
            return
        }
    }
    Remove-Item -LiteralPath (Join-Path $PidRoot ("{0}.pid" -f $Name.ToLowerInvariant())) -Force
    Write-Host "[STOP] $Name PID $($process.Id)"
}

function Remove-OwnedPidFile {
    param([string]$Name, [int]$ProcessId)

    $pidPath = Join-Path $PidRoot ("{0}.pid" -f $Name.ToLowerInvariant())
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return
    }
    $recordedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($recordedPid -eq [string]$ProcessId) {
        Remove-Item -LiteralPath $pidPath -Force
    }
}

function Show-Status {
    param([hashtable]$Executables)

    foreach ($name in $Components.Keys) {
        $process = Get-ManagedProcess -Name $name -ExpectedExecutable $Executables[$name]
        if (-not $process) {
            Write-Host ("{0,-12} stopped" -f $name)
            continue
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Components[$name].ReadyUrl -TimeoutSec 2
            $health = "HTTP $($response.StatusCode)"
        } catch {
            $health = "probe failed: $($_.Exception.Message)"
        }
        Write-Host ("{0,-12} PID {1,-7} {2}" -f $name, $process.Id, $health)
    }
}

function Test-ObservabilityConfigurations {
    param([hashtable]$Executables)

    $promtool = Get-ChildItem -LiteralPath (Get-InstallDirectory -Name "Prometheus" -Component $Components.Prometheus) -Filter "promtool.exe" -File -Recurse | Select-Object -First 1
    if (-not $promtool) {
        throw "Prometheus installation does not contain promtool.exe"
    }
    & $promtool.FullName check config $PrometheusConfig
    if ($LASTEXITCODE -ne 0) {
        throw "Prometheus configuration validation failed"
    }

    $tempoData = (New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "tempo")).FullName.Replace("\", "/")
    Invoke-WithEnvironment -Environment @{ TEMPO_DATA_DIR = $tempoData } -Script {
        & $Executables.Tempo "--config.file=$TempoConfig" "--config.expand-env=true" "--config.verify=true"
        if ($LASTEXITCODE -ne 0) {
            throw "Tempo configuration validation failed"
        }
    }

    & $Executables.Collector validate "--config=$CollectorConfig"
    if ($LASTEXITCODE -ne 0) {
        throw "OpenTelemetry Collector configuration validation failed"
    }
}

function Get-ComponentRuntime {
    param([string]$Name, [hashtable]$Executables)

    switch ($Name) {
        "Prometheus" {
            $data = (New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "prometheus")).FullName
            return @{
                Executable = $Executables.Prometheus
                Arguments = @("--config.file=$PrometheusConfig", "--storage.tsdb.path=$data", "--web.listen-address=127.0.0.1:9090", "--web.enable-remote-write-receiver")
                StartArguments = '--config.file="' + $PrometheusConfig + '" --storage.tsdb.path="' + $data + '" --web.listen-address=127.0.0.1:9090 --web.enable-remote-write-receiver'
                WorkingDirectory = Split-Path -Parent $Executables.Prometheus
                Environment = @{}
            }
        }
        "Tempo" {
            $data = (New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "tempo")).FullName.Replace("\", "/")
            return @{
                Executable = $Executables.Tempo
                Arguments = @("--config.file=$TempoConfig", "--config.expand-env=true")
                StartArguments = '--config.file="' + $TempoConfig + '" --config.expand-env=true'
                WorkingDirectory = Split-Path -Parent $Executables.Tempo
                Environment = @{ TEMPO_DATA_DIR = $data }
            }
        }
        "Grafana" {
            $grafanaHome = Split-Path -Parent (Split-Path -Parent $Executables.Grafana)
            $data = (New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "grafana")).FullName
            $logs = (New-Item -ItemType Directory -Force -Path (Join-Path $LogRoot "grafana")).FullName
            $plugins = (New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeRoot "grafana-plugins")).FullName
            $arguments = if ((Split-Path -Leaf $Executables.Grafana) -eq "grafana.exe") {
                @("server", "--homepath", $grafanaHome)
            } else {
                @("--homepath", $grafanaHome)
            }
            $startArguments = if ((Split-Path -Leaf $Executables.Grafana) -eq "grafana.exe") {
                'server --homepath "' + $grafanaHome + '"'
            } else {
                '--homepath "' + $grafanaHome + '"'
            }
            return @{
                Executable = $Executables.Grafana
                Arguments = $arguments
                StartArguments = $startArguments
                WorkingDirectory = $grafanaHome
                Environment = @{
                    GF_SERVER_HTTP_ADDR = "127.0.0.1"
                    GF_SERVER_HTTP_PORT = "3000"
                    GF_PATHS_DATA = $data
                    GF_PATHS_LOGS = $logs
                    GF_PATHS_PLUGINS = $plugins
                    GF_PATHS_PROVISIONING = $GrafanaProvisioning
                    GF_ANALYTICS_REPORTING_ENABLED = "false"
                    GF_ANALYTICS_CHECK_FOR_UPDATES = "false"
                    GF_PLUGINS_PREINSTALL_DISABLED = "true"
                    GF_PLUGINS_PREINSTALL_AUTO_UPDATE = "false"
                    GF_AUTH_ANONYMOUS_ENABLED = "true"
                    GF_AUTH_ANONYMOUS_ORG_ROLE = "Viewer"
                    GF_AUTH_DISABLE_LOGIN_FORM = "true"
                }
            }
        }
        "Collector" {
            return @{
                Executable = $Executables.Collector
                Arguments = @("--config=$CollectorConfig")
                StartArguments = '--config="' + $CollectorConfig + '"'
                WorkingDirectory = Split-Path -Parent $Executables.Collector
                Environment = @{}
            }
        }
    }
}

function Invoke-ForegroundComponent {
    param([string]$Name, [hashtable]$Runtime)

    Assert-PortAvailable -Name $Name -Port $Components[$Name].Port
    $launchId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
    $stdoutPath = Join-Path $LogRoot ("{0}.{1}.supervised.stdout.log" -f $Name.ToLowerInvariant(), $launchId)
    $stderrPath = Join-Path $LogRoot ("{0}.{1}.supervised.stderr.log" -f $Name.ToLowerInvariant(), $launchId)

    $startArgs = @{
        FilePath = $Runtime.Executable
        ArgumentList = $Runtime.StartArguments
        WorkingDirectory = $Runtime.WorkingDirectory
        WindowStyle = "Hidden"
        RedirectStandardOutput = $stdoutPath
        RedirectStandardError = $stderrPath
        PassThru = $true
    }
    $process = Invoke-WithEnvironment -Environment $Runtime.Environment -Script { Start-Process @startArgs }
    $pidPath = Join-Path $PidRoot ("{0}.pid" -f $Name.ToLowerInvariant())
    Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
    Write-Host "[RUN] $Name PID $($process.Id); stdout=$stdoutPath stderr=$stderrPath"

    try {
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    } finally {
        Remove-OwnedPidFile -Name $Name -ProcessId $process.Id
    }

    $exitHeader = "--- exit {0:o} code={1} ---" -f (Get-Date), $exitCode
    Add-Content -LiteralPath $stdoutPath -Value $exitHeader -Encoding utf8
    Add-Content -LiteralPath $stderrPath -Value $exitHeader -Encoding utf8
    if ([int]$exitCode -eq 0) {
        Write-Error "$Name exited unexpectedly with code 0; returning failure so Task Scheduler restarts it"
        exit 1
    }
    exit ([int]$exitCode)
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $InstallRoot, $DataRoot, $PidRoot, $LogRoot | Out-Null

$executables = @{}
foreach ($name in $Components.Keys) {
    $executables[$name] = Install-Component -Name $name -Component $Components[$name]
}

if ($Action -eq "Stop") {
    foreach ($name in @("Collector", "Grafana", "Tempo", "Prometheus")) {
        Stop-Component -Name $name -Executable $executables[$name]
    }
    return
}

if ($Action -eq "Status") {
    Show-Status -Executables $executables
    return
}
if ($Action -eq "RunComponent") {
    if (-not $Component) {
        throw "-Component is required when -Action RunComponent is used"
    }
    $runtime = Get-ComponentRuntime -Name $Component -Executables $executables
    Invoke-ForegroundComponent -Name $Component -Runtime $runtime
}

Test-ObservabilityConfigurations -Executables $executables
if ($Action -eq "Prepare") {
    Write-Host "[READY] Native observability binaries and configurations"
    return
}
$prometheusRuntime = Get-ComponentRuntime -Name "Prometheus" -Executables $executables
Start-ManagedProcess -Name "Prometheus" -Executable $prometheusRuntime.Executable -Arguments $prometheusRuntime.StartArguments -WorkingDirectory $prometheusRuntime.WorkingDirectory -Environment $prometheusRuntime.Environment | Out-Null
Wait-HttpReady -Name "Prometheus" -Uri $Components.Prometheus.ReadyUrl -TimeoutSeconds $StartupTimeoutSeconds

$tempoRuntime = Get-ComponentRuntime -Name "Tempo" -Executables $executables
Start-ManagedProcess -Name "Tempo" -Executable $tempoRuntime.Executable -Arguments $tempoRuntime.StartArguments -WorkingDirectory $tempoRuntime.WorkingDirectory -Environment $tempoRuntime.Environment | Out-Null
Wait-HttpReady -Name "Tempo" -Uri $Components.Tempo.ReadyUrl -TimeoutSeconds $StartupTimeoutSeconds

$grafanaRuntime = Get-ComponentRuntime -Name "Grafana" -Executables $executables
Start-ManagedProcess -Name "Grafana" -Executable $grafanaRuntime.Executable -Arguments $grafanaRuntime.StartArguments -WorkingDirectory $grafanaRuntime.WorkingDirectory -Environment $grafanaRuntime.Environment | Out-Null
$grafanaTimeoutSeconds = [Math]::Max($StartupTimeoutSeconds, 120)
Wait-HttpReady -Name "Grafana" -Uri $Components.Grafana.ReadyUrl -TimeoutSeconds $grafanaTimeoutSeconds

$collectorRuntime = Get-ComponentRuntime -Name "Collector" -Executables $executables
Start-ManagedProcess -Name "Collector" -Executable $collectorRuntime.Executable -Arguments $collectorRuntime.StartArguments -WorkingDirectory $collectorRuntime.WorkingDirectory -Environment $collectorRuntime.Environment | Out-Null
Wait-HttpReady -Name "Collector" -Uri $Components.Collector.ReadyUrl -TimeoutSeconds $StartupTimeoutSeconds

Write-Host "[READY] Native observability stack"
Write-Host "        Grafana:    http://127.0.0.1:3000"
Write-Host "        Prometheus: http://127.0.0.1:9090"
Write-Host "        Tempo:      http://127.0.0.1:3200"
