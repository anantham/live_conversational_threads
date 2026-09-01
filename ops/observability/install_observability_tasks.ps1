param(
    [ValidateSet("Plan", "Probe", "Install", "Reconcile", "Uninstall", "Start", "Stop", "Restart", "Status")]
    [string]$Action = "Plan",
    [ValidateSet("Collector", "Prometheus", "Tempo", "Grafana")]
    [string]$Component,
    [ValidateRange(120, 600)]
    [int]$InstallReadinessBudgetSeconds = 300
)

$ErrorActionPreference = "Stop"
$TaskPrefix = "LCT-Observability-"
$Launcher = Join-Path $PSScriptRoot "start_observability.ps1"
$TaskWrapper = Join-Path $PSScriptRoot "run_observability_task.ps1"
$MigrationModule = Join-Path $PSScriptRoot "ObservabilityMigration.psm1"
$ProcessOwnershipModule = Join-Path $PSScriptRoot "ObservabilityProcessOwnership.psm1"
$RuntimeRoot = "C:\ProgramData\LCT\observability"
$LegacyRuntimeRoot = Join-Path $env:LOCALAPPDATA "LCT\observability"
$MigrationJournalRoot = "C:\ProgramData\LCT\migration-journals"
$TaskLogRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")) "logs\observability"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$HttpProbeTimeoutSeconds = 3
$RestartPidSloSeconds = 90
$HealthCheckIntervalSeconds = 10
$HealthFailureThreshold = 6
$ComponentOrder = @("Prometheus", "Tempo", "Grafana", "Collector")
$ExecutableNames = [ordered]@{
    Prometheus = "prometheus.exe"
    Tempo = "tempo.exe"
    Grafana = "grafana.exe"
    Collector = "otelcol-contrib.exe"
}
$ReadyUrls = [ordered]@{
    Prometheus = "http://127.0.0.1:9090/-/ready"
    Tempo = "http://127.0.0.1:3200/ready"
    Grafana = "http://127.0.0.1:3000/api/health"
    Collector = "http://127.0.0.1:13133/"
}

function Get-TaskArguments {
    param([string]$Component)

    return '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $TaskWrapper + '" -Action RunComponent -Component ' + $Component + ' -RuntimeRoot "' + $RuntimeRoot + '" -StartupTimeoutSeconds ' + $InstallReadinessBudgetSeconds + ' -HealthCheckIntervalSeconds ' + $HealthCheckIntervalSeconds + ' -HealthFailureThreshold ' + $HealthFailureThreshold + ' -SkipDownload'
}

function Resolve-TargetComponents {
    if ($Component) {
        return @($Component)
    }
    return @($ComponentOrder)
}

function Get-TaskPlan {
    $tasks = foreach ($component in $ComponentOrder) {
        [ordered]@{
            component = $component
            task_name = "$TaskPrefix$component"
            executable = $PowerShellExe
            arguments = Get-TaskArguments -Component $component
            ready_url = $ReadyUrls[$component]
            pid_path = Join-Path $RuntimeRoot ("pids\{0}.pid" -f $component.ToLowerInvariant())
            ownership_contract = "native-pid-file-and-listener"
            health_check_interval_seconds = $HealthCheckIntervalSeconds
            health_failure_threshold = $HealthFailureThreshold
        }
    }

    return [ordered]@{
        schema_version = 1
        owner = "windows-task-scheduler"
        logon_type = "interactive"
        restart_interval_seconds = 60
        restart_count = 999
        restart_pid_slo_seconds = $RestartPidSloSeconds
        health_check_interval_seconds = $HealthCheckIntervalSeconds
        health_failure_threshold = $HealthFailureThreshold
        install_readiness_budget_seconds = $InstallReadinessBudgetSeconds
        http_probe_timeout_seconds = $HttpProbeTimeoutSeconds
        manual_launcher_stopped_before_install = $true
        runtime_root = $RuntimeRoot
        migration = [ordered]@{
            strategy = "fresh-stage-journaled-rename"
            source_policy = "stopped-legacy-runtime-is-authoritative"
            never_merge_mutable_state = $true
            preserve_legacy_source = $true
            preserve_prior_programdata_tree = $true
        }
        tasks = @($tasks)
    }
}

function Get-RegisteredTask {
    param([string]$TaskName)

    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Wait-TaskStopped {
    param([string]$TaskName, [int]$TimeoutSeconds = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $task = Get-RegisteredTask -TaskName $TaskName
        if (-not $task -or $task.State -ne "Running") {
            return
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Scheduled task $TaskName did not stop within $TimeoutSeconds seconds"
}

function Get-ComponentNativePid {
    param([string]$Component)

    $pidPath = Join-Path $RuntimeRoot ("pids\{0}.pid" -f $Component.ToLowerInvariant())
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
        return $null
    }
    $rawPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    $nativePid = 0
    if (-not [int]::TryParse($rawPid, [ref]$nativePid) -or $nativePid -le 0) {
        throw "$Component PID file is invalid at $pidPath`: $rawPid"
    }
    return $nativePid
}

function Get-ComponentOwnership {
    param([string]$Component)

    $nativePid = Get-ComponentNativePid -Component $Component
    $process = if ($nativePid) { Get-Process -Id $nativePid -ErrorAction SilentlyContinue } else { $null }
    $processPath = $null
    if ($process) {
        try {
            $processPath = $process.Path
        } catch {
            $processPath = $null
        }
    }
    $binRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot "bin")).TrimEnd("\") + "\"
    $processOwned = $false
    if ($processPath) {
        $fullProcessPath = [IO.Path]::GetFullPath($processPath)
        $processOwned = $fullProcessPath.StartsWith($binRoot, [StringComparison]::OrdinalIgnoreCase) -and
            ([IO.Path]::GetFileName($fullProcessPath)).Equals($ExecutableNames[$Component], [StringComparison]::OrdinalIgnoreCase)
    }

    $port = ([Uri]$ReadyUrls[$Component]).Port
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    $listenerOwned = $processOwned -and @($listeners | Where-Object { $_.OwningProcess -eq $nativePid }).Count -gt 0
    $conflictingListeners = @($listeners | Where-Object { -not $nativePid -or $_.OwningProcess -ne $nativePid })
    [pscustomobject][ordered]@{
        native_pid = $nativePid
        pid_path = Join-Path $RuntimeRoot ("pids\{0}.pid" -f $Component.ToLowerInvariant())
        process_path = $processPath
        process_owned = $processOwned
        listener_owned = $listenerOwned
        conflicting_listener_pids = @($conflictingListeners | Select-Object -ExpandProperty OwningProcess -Unique)
    }
}

function Get-RecentComponentFailure {
    param([string]$Component, [DateTimeOffset]$Since)

    $lifecyclePath = Join-Path $TaskLogRoot ("{0}.task.jsonl" -f $Component.ToLowerInvariant())
    if (-not (Test-Path -LiteralPath $lifecyclePath -PathType Leaf)) {
        return $null
    }
    $records = foreach ($line in Get-Content -LiteralPath $lifecyclePath -Tail 200) {
        try {
            $record = $line | ConvertFrom-Json
            $timestamp = [DateTimeOffset]::Parse($record.timestamp)
        } catch {
            continue
        }
        if ($timestamp -ge $Since -and $record.event -in @("child_exit", "wrapper_failure")) {
            $record
        }
    }
    return @($records | Select-Object -Last 1)[0]
}

function Get-RecentNativeStderr {
    param([string]$Component)

    $pattern = "{0}.*.supervised.stderr.log" -f $Component.ToLowerInvariant()
    $latest = Get-ChildItem -LiteralPath $TaskLogRoot -File -Filter $pattern -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latest) {
        return "(no supervised stderr log)"
    }
    return (Get-Content -LiteralPath $latest.FullName -Tail 40 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
}

function Wait-ComponentReady {
    param([string]$Component, [int]$TimeoutSeconds = $InstallReadinessBudgetSeconds)

    $uri = $ReadyUrls[$Component]
    $taskName = "$TaskPrefix$Component"
    $startedAt = [DateTimeOffset]::UtcNow.AddSeconds(-2)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = "native PID has not been published"
    do {
        $ownership = Get-ComponentOwnership -Component $Component
        if ($ownership.conflicting_listener_pids.Count -gt 0) {
            throw "$Component port is owned by an unverified PID: $($ownership.conflicting_listener_pids -join ', ')"
        }

        if ($ownership.process_owned -and $ownership.listener_owned) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $HttpProbeTimeoutSeconds
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                    $confirmed = Get-ComponentOwnership -Component $Component
                    if ($confirmed.native_pid -eq $ownership.native_pid -and $confirmed.process_owned -and $confirmed.listener_owned) {
                        Write-Host "[READY] $Component PID $($ownership.native_pid) owns $uri"
                        return $confirmed
                    }
                    $lastError = "ownership changed during the readiness probe"
                } else {
                    $lastError = "HTTP $($response.StatusCode)"
                }
            } catch {
                $lastError = $_.Exception.Message
            }
        } elseif ($ownership.native_pid) {
            $lastError = "PID $($ownership.native_pid) is not the expected live listener"
        }

        $failure = Get-RecentComponentFailure -Component $Component -Since $startedAt
        if ($failure -and -not $ownership.process_owned) {
            $tail = Get-RecentNativeStderr -Component $Component
            throw "$Component task exited before readiness (event=$($failure.event), exit_code=$($failure.exit_code)). Recent stderr:`n$tail"
        }
        if (-not (Get-RegisteredTask -TaskName $taskName)) {
            throw "Scheduled task $taskName disappeared while waiting for readiness"
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    $tail = Get-RecentNativeStderr -Component $Component
    throw "$Component did not establish PID-bound readiness at $uri within $TimeoutSeconds seconds. Last evidence: $lastError`nRecent stderr:`n$tail"
}

function Test-TaskEntry {
    param([switch]$RequireRuntimeFiles)

    $taskName = "$TaskPrefix`Probe"
    $runId = [Guid]::NewGuid()
    $probeLog = Join-Path $TaskLogRoot "task-entry-probe.jsonl"
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
        -Hidden `
        -MultipleInstances IgnoreNew
    $taskAction = New-ScheduledTaskAction `
        -Execute $PowerShellExe `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $TaskWrapper + '" -Action Probe -RunId ' + $runId + ' -RuntimeRoot "' + $RuntimeRoot + '"') `
        -WorkingDirectory $PSScriptRoot

    try {
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $taskAction `
            -Principal $principal `
            -Settings $settings `
            -Description "Verifies that the local observability task wrapper can enter under the production task principal." `
            -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName

        $deadline = (Get-Date).AddSeconds(30)
        do {
            if (Test-Path -LiteralPath $probeLog) {
                $runtimeCheck = $null
                $probeComplete = $false
                $probeFailure = $null
                foreach ($line in Get-Content -LiteralPath $probeLog -Tail 30) {
                    try {
                        $record = $line | ConvertFrom-Json
                    } catch {
                        continue
                    }
                    if ($record.run_id -ne $runId.ToString()) {
                        continue
                    }
                    if ($record.event -eq "runtime_check") {
                        $runtimeCheck = $record
                    }
                    if ($record.event -eq "probe_complete") {
                        $probeComplete = $true
                    }
                    if ($record.event -eq "probe_failure") {
                        $probeFailure = $record
                    }
                }
                if ($probeFailure) {
                    throw "Task Scheduler probe failed inside the wrapper (type=$($probeFailure.exception_type)): $($probeFailure.error)"
                }
                if ($probeComplete) {
                    if (-not $runtimeCheck) {
                        throw "Task Scheduler probe completed without a runtime visibility record for $RuntimeRoot"
                    }
                    if (-not $runtimeCheck.runtime_root_exists) {
                        throw "Task Scheduler entered the wrapper but cannot see runtime root $RuntimeRoot"
                    }
                    if ($RequireRuntimeFiles -and (-not $runtimeCheck.collector_marker_exists -or -not $runtimeCheck.collector_executable_exists)) {
                        throw "Task Scheduler can see $RuntimeRoot but cannot read the migrated Collector marker or executable"
                    }
                    Write-Host "[PROBE] Task Scheduler entered the wrapper and can read $RuntimeRoot for run $runId"
                    return
                }
            }
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $deadline)

        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        $result = if ($info) { $info.LastTaskResult } else { "unavailable" }
        throw "Task Scheduler did not write the wrapper probe marker within 30 seconds (last task result: $result). Stop here and inspect Windows task action/session policy."
    } finally {
        $task = Get-RegisteredTask -TaskName $taskName
        if ($task -and $task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $taskName
            Wait-TaskStopped -TaskName $taskName
        }
        if (Get-RegisteredTask -TaskName $taskName) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    }
}

function Assert-ApprovedRuntimeRoot {
    $approvedRoot = [IO.Path]::GetFullPath("C:\ProgramData\LCT\observability").TrimEnd("\")
    $candidateRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\")
    if (-not $candidateRoot.Equals($approvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing machine-scoped migration outside the approved runtime root: $RuntimeRoot"
    }
}

function Assert-ApprovedMigrationPath {
    param([string]$Path)

    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd("\")
    $approvedParent = [IO.Path]::GetFullPath("C:\ProgramData\LCT").TrimEnd("\")
    $candidateParent = [IO.Path]::GetFullPath((Split-Path -Parent $candidate)).TrimEnd("\")
    $candidateName = Split-Path -Leaf $candidate
    if (-not $candidateParent.Equals($approvedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing migration path outside the approved ProgramData parent: $candidate"
    }
    if ($candidateName -notmatch '^observability(?:\.(?:stage|rollback|failed-live|failed-stage)-[0-9a-f]{32})?$') {
        throw "Refusing unexpected observability migration path: $candidate"
    }
}

function Assert-OrdinaryDirectory {
    param([string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        throw "Expected a directory: $Path"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing observability migration through a reparse point: $Path"
    }
}

function Set-RestrictedDirectoryAcl {
    param([string]$Path)

    Assert-ApprovedMigrationPath -Path $Path

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $aclArguments = @(
        $Path,
        "/inheritance:r",
        "/grant:r",
        "*${currentSid}:(OI)(CI)M",
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F"
    )
    & icacls.exe @aclArguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to assign the approved ACL to $Path (icacls exit code $LASTEXITCODE)"
    }

    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        throw "Runtime ACL still inherits permissions at $Path"
    }
    $expectedRights = @{
        $currentSid = [Security.AccessControl.FileSystemRights]::Modify
        "S-1-5-18" = [Security.AccessControl.FileSystemRights]::FullControl
        "S-1-5-32-544" = [Security.AccessControl.FileSystemRights]::FullControl
    }
    $actualRules = @{}
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        try {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        } catch {
            continue
        }
        $actualRules[$sid] = $rule.FileSystemRights
    }
    foreach ($sid in $expectedRights.Keys) {
        $required = $expectedRights[$sid]
        if (-not $actualRules.ContainsKey($sid) -or (($actualRules[$sid] -band $required) -ne $required)) {
            throw "Runtime ACL at $Path is missing $required for SID $sid"
        }
    }
    $unexpectedSids = @($actualRules.Keys | Where-Object { -not $expectedRights.ContainsKey($_) })
    if ($unexpectedSids.Count -gt 0) {
        throw "Runtime ACL at $Path grants unexpected identities: $($unexpectedSids -join ', ')"
    }
    Write-Host "[ACL] Restricted $Path to SYSTEM, Administrators, and the current user"
}

function Initialize-MigrationEnvironment {
    Assert-ApprovedRuntimeRoot
    $programDataParent = Split-Path -Parent $RuntimeRoot
    New-Item -ItemType Directory -Force -Path $programDataParent | Out-Null
    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
        throw "Existing ProgramData runtime is missing; refusing a swap without a retained prior tree: $RuntimeRoot"
    }
    Assert-OrdinaryDirectory -Path $RuntimeRoot
    Set-RestrictedDirectoryAcl -Path $RuntimeRoot

    if (-not (Test-Path -LiteralPath $MigrationJournalRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $MigrationJournalRoot | Out-Null
    }
    $journalAclArguments = @(
        $MigrationJournalRoot,
        "/inheritance:r",
        "/grant:r",
        "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(OI)(CI)M",
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F"
    )
    & icacls.exe @journalAclArguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict migration journal directory $MigrationJournalRoot"
    }
}

function New-FreshRuntimeStage {
    param($Descriptor)

    Assert-ApprovedMigrationPath -Path $Descriptor.stage_root
    if (Test-Path -LiteralPath $Descriptor.stage_root) {
        throw "Fresh staging path already exists: $($Descriptor.stage_root)"
    }
    New-Item -ItemType Directory -Path $Descriptor.stage_root | Out-Null
    Set-RestrictedDirectoryAcl -Path $Descriptor.stage_root
    Assert-OrdinaryDirectory -Path $Descriptor.stage_root
    if (@(Get-ChildItem -LiteralPath $Descriptor.stage_root -Force).Count -ne 0) {
        throw "Fresh staging directory is not empty: $($Descriptor.stage_root)"
    }
    Set-ObservabilityMigrationState -Descriptor $Descriptor -State "stage_created"
}

function Get-DirectoryByteCount {
    param([string]$Path)

    $measure = Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction Stop |
        Measure-Object -Property Length -Sum
    return [int64]$measure.Sum
}

function Assert-MigrationDiskCapacity {
    param([string]$SourceRoot, [string]$Phase)

    $sourceBytes = Get-DirectoryByteCount -Path $SourceRoot
    $requiredFreeBytes = ([int64]$sourceBytes * 2) + 10GB
    $driveRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($RuntimeRoot))
    $drive = [IO.DriveInfo]::new($driveRoot)
    if ($drive.AvailableFreeSpace -lt $requiredFreeBytes) {
        throw "Insufficient disk space during $Phase`: free=$($drive.AvailableFreeSpace) required=$requiredFreeBytes source=$sourceBytes"
    }
    Write-Host "[SPACE] $Phase free=$($drive.AvailableFreeSpace) required=$requiredFreeBytes source=$sourceBytes"
}

function Copy-LegacyRuntime {
    param([string]$DestinationRoot)

    Assert-ApprovedRuntimeRoot
    Assert-ApprovedMigrationPath -Path $DestinationRoot
    $sourceRoot = [IO.Path]::GetFullPath($LegacyRuntimeRoot).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Legacy observability runtime is missing: $sourceRoot"
    }
    if ($sourceRoot.Equals([IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Legacy and machine-scoped runtime roots unexpectedly resolve to the same path"
    }

    $copyArguments = @(
        $sourceRoot,
        $DestinationRoot,
        "/E",
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/R:2",
        "/W:2",
        "/XJ",
        "/XD",
        (Join-Path $sourceRoot "pids"),
        "/NFL",
        "/NDL",
        "/NP"
    )
    Write-Host "[COPY] Copying authoritative stopped runtime from $sourceRoot to fresh stage $DestinationRoot"
    & robocopy.exe @copyArguments | Out-Host
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
        throw "Runtime migration failed (robocopy exit code $copyExitCode)"
    }
    foreach ($relativePath in @("data\prometheus\lock", "data\prometheus\queries.active")) {
        $ephemeralPath = Join-Path $DestinationRoot $relativePath
        if (Test-Path -LiteralPath $ephemeralPath -PathType Leaf) {
            Remove-Item -LiteralPath $ephemeralPath -Force
            Write-Host "[COPY] Excluded process-ephemeral file $relativePath from staged state"
        }
    }
    Write-Host "[COPY] Runtime migration completed (robocopy exit code $copyExitCode)"
}

function Get-RuntimeInventory {
    param([string]$Root)

    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    $inventory = foreach ($file in Get-ChildItem -LiteralPath $fullRoot -Recurse -File -Force -ErrorAction Stop) {
        $relativePath = $file.FullName.Substring($fullRoot.Length).TrimStart("\")
        if ($relativePath.StartsWith("pids\", [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        if ($relativePath -in @("data\prometheus\lock", "data\prometheus\queries.active")) {
            continue
        }
        [pscustomobject]@{ relative_path = $relativePath; length = [int64]$file.Length }
    }
    return @($inventory | Sort-Object relative_path)
}

function Test-RuntimeInventory {
    param([string]$SourceRoot, [string]$DestinationRoot)

    $sourceInventory = @(Get-RuntimeInventory -Root $SourceRoot)
    $destinationInventory = @(Get-RuntimeInventory -Root $DestinationRoot)
    if ($sourceInventory.Count -ne $destinationInventory.Count) {
        throw "Staged runtime inventory count mismatch: source=$($sourceInventory.Count) destination=$($destinationInventory.Count)"
    }
    $destinationByPath = @{}
    foreach ($item in $destinationInventory) {
        $destinationByPath[$item.relative_path] = $item.length
    }
    foreach ($item in $sourceInventory) {
        if (-not $destinationByPath.ContainsKey($item.relative_path)) {
            throw "Staged runtime is missing $($item.relative_path)"
        }
        if ($destinationByPath[$item.relative_path] -ne $item.length) {
            throw "Staged runtime length mismatch for $($item.relative_path): source=$($item.length) destination=$($destinationByPath[$item.relative_path])"
        }
    }
    $sourceBytes = ($sourceInventory | Measure-Object -Property length -Sum).Sum
    $destinationBytes = ($destinationInventory | Measure-Object -Property length -Sum).Sum
    if ($sourceBytes -ne $destinationBytes) {
        throw "Staged runtime byte count mismatch: source=$sourceBytes destination=$destinationBytes"
    }
    Write-Host "[VERIFY] Staged inventory matches source: files=$($sourceInventory.Count) bytes=$sourceBytes extras=0"
}

function Test-PrometheusHeadContinuity {
    param([string]$Root)

    $headRoot = Join-Path $Root "data\prometheus\chunks_head"
    if (-not (Test-Path -LiteralPath $headRoot -PathType Container)) {
        return
    }
    $indexes = @(Get-ChildItem -LiteralPath $headRoot -File -Force | ForEach-Object {
        $value = 0
        if (-not [int]::TryParse($_.Name, [ref]$value)) {
            throw "Unexpected Prometheus head chunk filename: $($_.FullName)"
        }
        $value
    } | Sort-Object)
    for ($index = 1; $index -lt $indexes.Count; $index++) {
        if ($indexes[$index] -ne $indexes[$index - 1] + 1) {
            throw "Prometheus staged head is not contiguous: $($indexes -join ', ')"
        }
    }
    Write-Host "[VERIFY] Prometheus staged head is contiguous: $($indexes -join ', ')"
}

function Test-MigratedExecutableIntegrity {
    param([string]$SourceRoot, [string]$DestinationRoot)

    $sourceBin = Join-Path $SourceRoot "bin"
    $destinationBin = Join-Path $DestinationRoot "bin"

    foreach ($component in $ExecutableNames.Keys) {
        $executableName = $ExecutableNames[$component]
        $sourceMatches = @(Get-ChildItem -LiteralPath $sourceBin -Recurse -File -Filter $executableName)
        $destinationMatches = @(Get-ChildItem -LiteralPath $destinationBin -Recurse -File -Filter $executableName)
        if ($sourceMatches.Count -ne 1 -or $destinationMatches.Count -ne 1) {
            throw "Expected exactly one $executableName in each runtime, found source=$($sourceMatches.Count) destination=$($destinationMatches.Count)"
        }

        $sourceHash = Get-FileHash -LiteralPath $sourceMatches[0].FullName -Algorithm SHA256
        $destinationHash = Get-FileHash -LiteralPath $destinationMatches[0].FullName -Algorithm SHA256
        if ($sourceHash.Hash -ne $destinationHash.Hash) {
            throw "$component executable failed SHA-256 migration verification: $($destinationMatches[0].FullName)"
        }
        Write-Host "[VERIFY] $component executable matches the legacy runtime (SHA-256 $($destinationHash.Hash))"
    }
}

function Wait-PortsReleased {
    param([string[]]$Components = $ComponentOrder, [int]$TimeoutSeconds = 30)

    $expectedPorts = @($Components | ForEach-Object { ([Uri]$ReadyUrls[$_]).Port })
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $expectedPorts })
        if ($listeners.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    $owners = $listeners | ForEach-Object { "port $($_.LocalPort) PID $($_.OwningProcess)" }
    throw "Telemetry ports were not released within $TimeoutSeconds seconds ($($owners -join '; ')). Refusing to adopt or terminate an unverified process."
}

function Stop-TaskSet {
    param([string[]]$Components = $ComponentOrder)

    $orderedTargets = @($ComponentOrder | Where-Object { $_ -in $Components })
    [array]::Reverse($orderedTargets)
    foreach ($component in $orderedTargets) {
        $taskName = "$TaskPrefix$component"
        $task = Get-RegisteredTask -TaskName $taskName
        if ($task -and $task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $taskName
            Wait-TaskStopped -TaskName $taskName
            Write-Host "[STOP] $taskName"
        }
    }
}

function Unregister-TaskSet {
    foreach ($component in $ComponentOrder) {
        $taskName = "$TaskPrefix$component"
        if (Get-RegisteredTask -TaskName $taskName) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "[REMOVE] $taskName"
        }
    }
}

function Start-LegacyManualStack {
    Write-Warning "Scheduled-task adoption failed; restoring the manual stack from $LegacyRuntimeRoot"
    & $Launcher `
        -Action Start `
        -RuntimeRoot $LegacyRuntimeRoot `
        -StartupTimeoutSeconds $InstallReadinessBudgetSeconds `
        -SkipDownload
    Write-Host "[ROLLBACK] Legacy manual observability stack is healthy"
}

function Stop-SupervisedRuntime {
    param([string[]]$Components = $ComponentOrder)

    foreach ($target in $Components) {
        & $Launcher -Action Stop -Component $target -RuntimeRoot $RuntimeRoot -SkipDownload
    }
}

function Stop-OrphanedRuntimeHelpers {
    param([string[]]$Roots, [string[]]$Components = $ComponentOrder)

    if ("Grafana" -notin $Components) {
        return
    }

    foreach ($root in @($Roots | Where-Object { $_ } | Select-Object -Unique)) {
        Stop-ObservabilityOrphanedGrafanaPluginProcesses -RuntimeRoot $root | Out-Null
    }
}

function Start-TaskSet {
    param([string[]]$Components = $ComponentOrder)

    foreach ($component in @($ComponentOrder | Where-Object { $_ -in $Components })) {
        $taskName = "$TaskPrefix$component"
        if (-not (Get-RegisteredTask -TaskName $taskName)) {
            throw "Scheduled task $taskName is not installed"
        }
        $task = Get-RegisteredTask -TaskName $taskName
        if ($task.State -ne "Running") {
            Start-ScheduledTask -TaskName $taskName
        }
        Wait-ComponentReady -Component $component -TimeoutSeconds $InstallReadinessBudgetSeconds | Out-Null
    }
}

function Restart-TaskSet {
    param([string[]]$Components = $ComponentOrder)

    Stop-TaskSet -Components $Components
    Stop-SupervisedRuntime -Components $Components
    Stop-OrphanedRuntimeHelpers -Roots @($RuntimeRoot) -Components $Components
    Wait-PortsReleased -Components $Components
    Start-TaskSet -Components $Components
}

function Recover-IncompleteMigrations {
    if (-not (Test-Path -LiteralPath $MigrationJournalRoot -PathType Container)) {
        return
    }
    $incomplete = @()
    foreach ($journalFile in @(Get-ChildItem -LiteralPath $MigrationJournalRoot -File -Filter "migration-*.json")) {
        $descriptor = Read-ObservabilityMigrationJournal -Path $journalFile.FullName
        if ($descriptor.state -notin @("committed", "rolled_back")) {
            $incomplete += $descriptor
        }
    }
    if ($incomplete.Count -eq 0) {
        return
    }

    Write-Warning "Recovering $($incomplete.Count) interrupted observability migration(s) before starting a new run"
    Stop-TaskSet
    if (Test-Path -LiteralPath $RuntimeRoot -PathType Container) {
        Stop-SupervisedRuntime
    }
    & $Launcher -Action Stop -RuntimeRoot $LegacyRuntimeRoot -SkipDownload
    Stop-OrphanedRuntimeHelpers -Roots @($LegacyRuntimeRoot, $RuntimeRoot)
    Wait-PortsReleased
    Assert-NoRuntimeProcesses -Roots @($LegacyRuntimeRoot, $RuntimeRoot)
    Unregister-TaskSet
    $recovered = @(Get-IncompleteObservabilityMigrations -JournalRoot $MigrationJournalRoot)
    foreach ($descriptor in $recovered) {
        Write-Host "[RECOVER] Restored pre-migration runtime for run $($descriptor.run_id)"
    }
    Start-LegacyManualStack
}

function Register-TaskSet {
    param([string[]]$Components = $ComponentOrder)

    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -Hidden `
        -MultipleInstances IgnoreNew `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable

    foreach ($component in @($ComponentOrder | Where-Object { $_ -in $Components })) {
        $taskName = "$TaskPrefix$component"
        $taskAction = New-ScheduledTaskAction `
            -Execute $PowerShellExe `
            -Argument (Get-TaskArguments -Component $component) `
            -WorkingDirectory $PSScriptRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $taskAction `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -Description "Supervises the local $component observability component; restarts it after unexpected exit." `
            -Force | Out-Null
        Write-Host "[INSTALL] $taskName"
    }
}

function Reconcile-TaskSet {
    param([string[]]$Components = $ComponentOrder)

    Assert-ApprovedRuntimeRoot
    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
        throw "Cannot reconcile task supervision because the existing runtime is missing: $RuntimeRoot"
    }
    Assert-OrdinaryDirectory -Path $RuntimeRoot
    & $Launcher -Action Prepare -RuntimeRoot $RuntimeRoot -SkipDownload
    Test-TaskEntry -RequireRuntimeFiles
    Register-TaskSet -Components $Components
    Start-TaskSet -Components $Components
    Write-Host "[READY] Reconciled native observability task supervision without migrating runtime data or stopping native children"
}

function Show-TaskStatus {
    param([string[]]$Components = $ComponentOrder)

    $status = foreach ($component in @($ComponentOrder | Where-Object { $_ -in $Components })) {
        $taskName = "$TaskPrefix$component"
        $task = Get-RegisteredTask -TaskName $taskName
        $info = if ($task) { Get-ScheduledTaskInfo -TaskName $taskName } else { $null }
        $ready = $false
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $ReadyUrls[$component] -TimeoutSec 2
            $ready = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
        } catch {
            $ready = $false
        }
        $ownership = Get-ComponentOwnership -Component $component
        [ordered]@{
            component = $component
            task_name = $taskName
            installed = $null -ne $task
            state = if ($task) { [string]$task.State } else { "NotInstalled" }
            last_task_result = if ($info) { $info.LastTaskResult } else { $null }
            ready = $ready
            ready_url = $ReadyUrls[$component]
            native_pid = $ownership.native_pid
            process_owned = $ownership.process_owned
            listener_owned = $ownership.listener_owned
            process_path = $ownership.process_path
        }
    }
    [ordered]@{ schema_version = 1; tasks = @($status) } | ConvertTo-Json -Depth 5
}

if ($Action -eq "Plan") {
    Get-TaskPlan | ConvertTo-Json -Depth 5
    return
}
if ($Component -and $Action -notin @("Reconcile", "Start", "Stop", "Restart", "Status")) {
    throw "-Component is supported only for Reconcile, Start, Stop, Restart, and Status"
}

if (-not (Test-Path -LiteralPath $Launcher)) {
    throw "Observability launcher is missing: $Launcher"
}
if (-not (Test-Path -LiteralPath $TaskWrapper)) {
    throw "Observability task wrapper is missing: $TaskWrapper"
}
if (-not (Test-Path -LiteralPath $MigrationModule)) {
    throw "Observability migration module is missing: $MigrationModule"
}
if (-not (Test-Path -LiteralPath $ProcessOwnershipModule)) {
    throw "Observability process ownership module is missing: $ProcessOwnershipModule"
}
Import-Module $MigrationModule -Force
Import-Module $ProcessOwnershipModule -Force

switch ($Action) {
    "Probe" {
        Test-TaskEntry
    }
    "Install" {
        $manualOwnershipChanged = $false
        $descriptor = $null
        try {
            Initialize-MigrationEnvironment
            Recover-IncompleteMigrations
            Test-TaskEntry
            & $Launcher -Action Prepare -RuntimeRoot $LegacyRuntimeRoot -SkipDownload

            $manualOwnershipChanged = $true
            Stop-TaskSet
            & $Launcher -Action Stop -RuntimeRoot $LegacyRuntimeRoot -SkipDownload
            Stop-SupervisedRuntime
            Stop-OrphanedRuntimeHelpers -Roots @($LegacyRuntimeRoot, $RuntimeRoot)
            Wait-PortsReleased
            Assert-NoRuntimeProcesses -Roots @($LegacyRuntimeRoot, $RuntimeRoot)
            Unregister-TaskSet

            $descriptor = New-ObservabilityMigrationDescriptor `
                -LiveRoot $RuntimeRoot `
                -JournalRoot $MigrationJournalRoot
            Write-ObservabilityMigrationJournal -Descriptor $descriptor
            New-FreshRuntimeStage -Descriptor $descriptor
            Assert-MigrationDiskCapacity -SourceRoot $LegacyRuntimeRoot -Phase "before stage copy"
            Copy-LegacyRuntime -DestinationRoot $descriptor.stage_root
            Set-ObservabilityMigrationState -Descriptor $descriptor -State "copied"
            Test-RuntimeInventory -SourceRoot $LegacyRuntimeRoot -DestinationRoot $descriptor.stage_root
            Test-PrometheusHeadContinuity -Root $LegacyRuntimeRoot
            Test-PrometheusHeadContinuity -Root $descriptor.stage_root
            Test-MigratedExecutableIntegrity -SourceRoot $LegacyRuntimeRoot -DestinationRoot $descriptor.stage_root
            & $Launcher -Action Prepare -RuntimeRoot $descriptor.stage_root -SkipDownload
            Set-ObservabilityMigrationState -Descriptor $descriptor -State "validated"
            Assert-MigrationDiskCapacity -SourceRoot $LegacyRuntimeRoot -Phase "before runtime promotion"
            Assert-NoRuntimeProcesses -Roots @($LegacyRuntimeRoot, $RuntimeRoot, $descriptor.stage_root)

            Invoke-ObservabilityRuntimePromotion -Descriptor $descriptor
            Test-TaskEntry -RequireRuntimeFiles
            Stop-SupervisedRuntime
            Wait-PortsReleased
            Register-TaskSet
            Start-TaskSet
            Set-ObservabilityMigrationState -Descriptor $descriptor -State "committed"
            Write-Host "[READY] Native observability supervision is installed at $RuntimeRoot"
        } catch {
            $migrationFailure = $_
            if ($manualOwnershipChanged) {
                try {
                    Stop-TaskSet
                    Stop-SupervisedRuntime
                    Stop-OrphanedRuntimeHelpers -Roots @($LegacyRuntimeRoot, $RuntimeRoot)
                    Unregister-TaskSet
                    Wait-PortsReleased
                    $rollbackRoots = @($LegacyRuntimeRoot, $RuntimeRoot)
                    if ($descriptor) {
                        $rollbackRoots += $descriptor.stage_root
                    }
                    Assert-NoRuntimeProcesses -Roots $rollbackRoots
                    if ($descriptor -and $descriptor.state -notin @("committed", "rolled_back")) {
                        Restore-ObservabilityRuntime -Descriptor $descriptor
                    }
                    Start-LegacyManualStack
                } catch {
                    throw "Observability migration failed: $($migrationFailure.Exception.Message). Automatic legacy rollback also failed: $($_.Exception.Message)"
                }
            }
            throw $migrationFailure
        }
    }
    "Reconcile" {
        $targets = Resolve-TargetComponents
        Reconcile-TaskSet -Components $targets
    }
    "Uninstall" {
        Stop-TaskSet
        Stop-SupervisedRuntime
        Stop-OrphanedRuntimeHelpers -Roots @($RuntimeRoot)
        Wait-PortsReleased
        Unregister-TaskSet
    }
    "Start" {
        $targets = Resolve-TargetComponents
        Start-TaskSet -Components $targets
    }
    "Stop" {
        $targets = Resolve-TargetComponents
        Stop-TaskSet -Components $targets
        Stop-SupervisedRuntime -Components $targets
        Stop-OrphanedRuntimeHelpers -Roots @($RuntimeRoot) -Components $targets
        Wait-PortsReleased -Components $targets
    }
    "Restart" {
        $targets = Resolve-TargetComponents
        Restart-TaskSet -Components $targets
    }
    "Status" {
        $targets = Resolve-TargetComponents
        Show-TaskStatus -Components $targets
    }
}
