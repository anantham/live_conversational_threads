<#
.SYNOPSIS
Deploys prometheus-alerts.yml from origin/main to the running Prometheus and
proves, at Prometheus, that the rules were loaded and evaluate.

.DESCRIPTION
Run from the checkout Prometheus reads its configuration from:

    powershell -NoProfile -ExecutionPolicy Bypass -File ops\observability\deploy_alert_rules.ps1

Steps, each of which stops the deployment when it fails:
  1. Preconditions: this checkout is the one Prometheus reads, it is on the
     expected branch, and prometheus-alerts.yml has no local modifications.
  2. git fetch, validate the incoming prometheus.yml and prometheus-alerts.yml
     with promtool BEFORE touching the checkout, then git merge --ff-only.
     Anything other than a fast-forward is refused.
  3. promtool check rules / check config on the files now on disk.
  4. Make Prometheus load them with the least disruptive mechanism that
     exists: POST /-/reload when Prometheus runs with --web.enable-lifecycle,
     otherwise install_observability_tasks.ps1 -Action Restart -Component Prometheus.
     Skipped when Prometheus already loaded the files that are on disk.
  5. Verify at the receiver (GET /api/v1/rules, /metrics): the loaded alert
     rules are exactly the ones in the file, Prometheus loaded its
     configuration after the files last changed, and every rule group has
     evaluated with health "ok".

-WhatIf (or -DryRun) performs steps 1 and 3 and prints what the other steps
would do. -VerifyOnly performs step 5 alone. Neither changes anything.

Windows PowerShell 5.1 compatible.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoRoot,
    [string]$Remote = "origin",
    [string]$Branch = "main",
    [string]$PrometheusUrl = "http://127.0.0.1:9090",
    [string]$RuntimeRoot = "C:\ProgramData\LCT\observability",
    [ValidateRange(30, 900)]
    [int]$VerifyTimeoutSeconds = 180,
    [switch]$DryRun,
    [switch]$VerifyOnly,
    [switch]$ForceLoad
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($DryRun) {
    $WhatIfPreference = $true
}
$IsDryRun = [bool]$WhatIfPreference

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Join-Path $PSScriptRoot "..\.."
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd("\")
$RulesRelative = "ops/observability/prometheus-alerts.yml"
$ConfigRelative = "ops/observability/prometheus.yml"
$RulesFile = Join-Path $RepoRoot "ops\observability\prometheus-alerts.yml"
$ConfigFile = Join-Path $RepoRoot "ops\observability\prometheus.yml"
$TaskInstaller = Join-Path $RepoRoot "ops\observability\install_observability_tasks.ps1"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$PrometheusUrl = $PrometheusUrl.TrimEnd("/")
$Invariant = [Globalization.CultureInfo]::InvariantCulture

function Write-Step {
    param([string]$Tag, [string]$Message)
    Write-Host ("[{0}] {1}" -f $Tag, $Message)
}

function Invoke-Native {
    # Windows PowerShell 5 turns native stderr into error records; with
    # ErrorActionPreference=Stop that would abort on git's progress output.
    param([string]$FilePath, [string[]]$Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Invoke-Git {
    param([string[]]$Arguments, [switch]$AllowFailure)

    $result = Invoke-Native -FilePath "git.exe" -Arguments (@("-C", $RepoRoot) + $Arguments)
    if ($result.ExitCode -ne 0 -and -not $AllowFailure) {
        throw ("git {0} failed with exit code {1}:{2}{3}" -f ($Arguments -join " "), $result.ExitCode, [Environment]::NewLine, ($result.Output -join [Environment]::NewLine))
    }
    return $result
}

function Get-Promtool {
    $binRoot = Join-Path $RuntimeRoot "bin"
    $found = @()
    if (Test-Path -LiteralPath $binRoot -PathType Container) {
        $found = @(Get-ChildItem -LiteralPath $binRoot -Directory -Filter "prometheus-*" -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter "promtool.exe" -File -Recurse -ErrorAction SilentlyContinue } |
            Sort-Object FullName)
    }
    if ($found.Count -eq 0) {
        throw "promtool.exe was not found under $binRoot\prometheus-*. The rules cannot be validated, so nothing will be deployed."
    }
    return $found[-1].FullName
}

function Test-RulesWithPromtool {
    # Returns the number of rules promtool counted. Throws when either check fails.
    param([string]$Promtool, [string]$Rules, [string]$Config, [string]$Label)

    $rulesResult = Invoke-Native -FilePath $Promtool -Arguments @("check", "rules", $Rules)
    if ($rulesResult.ExitCode -ne 0) {
        throw ("promtool check rules FAILED for {0} ({1}):{2}{3}" -f $Label, $Rules, [Environment]::NewLine, ($rulesResult.Output -join [Environment]::NewLine))
    }
    $match = [regex]::Match(($rulesResult.Output -join "`n"), "SUCCESS:\s*(\d+)\s+rules found")
    if (-not $match.Success) {
        throw ("promtool check rules exited 0 for {0} but printed no rule count:{1}{2}" -f $Label, [Environment]::NewLine, ($rulesResult.Output -join [Environment]::NewLine))
    }
    $configResult = Invoke-Native -FilePath $Promtool -Arguments @("check", "config", $Config)
    if ($configResult.ExitCode -ne 0) {
        throw ("promtool check config FAILED for {0} ({1}):{2}{3}" -f $Label, $Config, [Environment]::NewLine, ($configResult.Output -join [Environment]::NewLine))
    }
    return [int]$match.Groups[1].Value
}

function Get-ExpectedRules {
    # Reads the alert names out of the rules file and cross-checks the count
    # against promtool's, so a layout this parser does not understand fails
    # loudly instead of producing a wrong expectation.
    param([string]$Rules, [int]$PromtoolRuleCount)

    $text = [IO.File]::ReadAllText($Rules)
    $alerts = @([regex]::Matches($text, "(?m)^[ \t]*-[ \t]+alert:[ \t]*[`"']?([^`"'\s#]+)") | ForEach-Object { $_.Groups[1].Value })
    $records = @([regex]::Matches($text, "(?m)^[ \t]*-[ \t]+record:[ \t]*\S"))
    if (($alerts.Count + $records.Count) -ne $PromtoolRuleCount) {
        throw ("Cannot count the rules in {0}: found {1} '- alert:' and {2} '- record:' entries, but promtool counts {3} rules. This script only understands rules whose first key is alert: or record:." -f $Rules, $alerts.Count, $records.Count, $PromtoolRuleCount)
    }
    return [pscustomobject]@{ AlertNames = @($alerts | Sort-Object); RecordingCount = $records.Count }
}

function ConvertTo-Timestamp {
    param($Value)

    if ($Value -is [DateTime]) {
        return [DateTimeOffset]$Value
    }
    # Prometheus prints up to nanoseconds; .NET parses at most 7 fractional digits.
    $text = [regex]::Replace([string]$Value, "(\.\d{7})\d+", '$1')
    return [DateTimeOffset]::Parse($text, $Invariant)
}

function Get-PrometheusFlags {
    return (Invoke-RestMethod -Uri "$PrometheusUrl/api/v1/status/flags" -TimeoutSec 10).data
}

function Get-PrometheusConfigLoad {
    # Read from /metrics, not from a query: a query returns the last scraped
    # sample, which after a restart still describes the previous process.
    $content = (Invoke-WebRequest -UseBasicParsing -Uri "$PrometheusUrl/metrics" -TimeoutSec 10).Content
    $timestamp = [regex]::Match($content, "(?m)^prometheus_config_last_reload_success_timestamp_seconds\s+(\S+)")
    $successful = [regex]::Match($content, "(?m)^prometheus_config_last_reload_successful\s+(\S+)")
    if (-not $timestamp.Success -or -not $successful.Success) {
        throw "Prometheus /metrics did not expose prometheus_config_last_reload_* metrics"
    }
    $seconds = [double]::Parse($timestamp.Groups[1].Value, [Globalization.NumberStyles]::Float, $Invariant)
    return [pscustomobject]@{
        LoadedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long][Math]::Floor($seconds * 1000))
        Successful = ([double]::Parse($successful.Groups[1].Value, [Globalization.NumberStyles]::Float, $Invariant) -eq 1)
    }
}

function Get-NewestSourceWrite {
    $newest = [DateTimeOffset]::MinValue
    foreach ($path in @($RulesFile, $ConfigFile)) {
        $written = [DateTimeOffset](Get-Item -LiteralPath $path).LastWriteTimeUtc
        if ($written -gt $newest) {
            $newest = $written
        }
    }
    return $newest
}

function Test-SamePath {
    param([string]$Left, [string]$Right)

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
}

function Get-ReceiverState {
    # One read of what Prometheus actually holds, compared with the files on disk.
    #   Problems: definite mismatches; waiting cannot fix them.
    #   Pending:  groups that have not produced a fresh evaluation yet.
    param([object]$Expected, [DateTimeOffset]$EvaluatedAfter)

    $problems = New-Object System.Collections.Generic.List[string]
    $pending = New-Object System.Collections.Generic.List[string]

    $flags = Get-PrometheusFlags
    $runningConfig = [string]$flags.'config.file'
    if (-not (Test-SamePath -Left $runningConfig -Right $ConfigFile)) {
        $problems.Add("Prometheus runs with --config.file=$runningConfig, not $ConfigFile. Run this script from the checkout Prometheus reads.")
    }

    $load = Get-PrometheusConfigLoad
    $newestWrite = Get-NewestSourceWrite
    if (-not $load.Successful) {
        $problems.Add("Prometheus reports that its last configuration load FAILED (prometheus_config_last_reload_successful = 0).")
    }
    if ($load.LoadedAt -lt $newestWrite) {
        $problems.Add(("Prometheus last loaded its configuration at {0:o}, before the files on disk changed ({1:o}). It is not running the current rules." -f $load.LoadedAt.ToLocalTime(), $newestWrite.ToLocalTime()))
    }

    $groups = @((Invoke-RestMethod -Uri "$PrometheusUrl/api/v1/rules" -TimeoutSec 20).data.groups)
    $ourGroups = @($groups | Where-Object { Test-SamePath -Left ([string]$_.file) -Right $RulesFile })
    if ($ourGroups.Count -eq 0) {
        $otherFiles = @($groups | ForEach-Object { [string]$_.file } | Sort-Object -Unique)
        $problems.Add("Prometheus has no rule group loaded from $RulesFile. Files it did load: $($otherFiles -join '; ')")
    }

    $loadedAlerts = @($ourGroups | ForEach-Object { $_.rules } | Where-Object { $_.type -eq "alerting" } | ForEach-Object { [string]$_.name } | Sort-Object)
    if ($loadedAlerts.Count -ne $Expected.AlertNames.Count) {
        $problems.Add("Prometheus has $($loadedAlerts.Count) alert rules loaded from this file; the file defines $($Expected.AlertNames.Count).")
    }
    $expectedNames = @($Expected.AlertNames)
    $onlyInFile = @($expectedNames | Where-Object { $loadedAlerts -notcontains $_ } | Sort-Object -Unique)
    $onlyLoaded = @($loadedAlerts | Where-Object { $expectedNames -notcontains $_ } | Sort-Object -Unique)
    if ($onlyInFile.Count -gt 0) {
        $problems.Add("In the file but NOT loaded: $($onlyInFile -join ', ')")
    }
    if ($onlyLoaded.Count -gt 0) {
        $problems.Add("Loaded but NOT in the file: $($onlyLoaded -join ', ')")
    }

    $rows = foreach ($group in $ourGroups) {
        $rules = @($group.rules)
        $lastEvaluation = ConvertTo-Timestamp -Value $group.lastEvaluation
        $failing = @($rules | Where-Object { $_.health -eq "err" })
        $unknown = @($rules | Where-Object { $_.health -ne "ok" -and $_.health -ne "err" })
        foreach ($rule in $failing) {
            $problems.Add("Group $($group.name): rule $($rule.name) fails to evaluate: $($rule.lastError)")
        }
        if ($lastEvaluation -le $EvaluatedAfter) {
            $pending.Add("group $($group.name) has not evaluated since the rules were loaded")
        } elseif ($unknown.Count -gt 0) {
            $pending.Add("group $($group.name) has $($unknown.Count) rule(s) without a health result yet")
        }
        [pscustomobject]@{
            Group = [string]$group.name
            Alerts = @($rules | Where-Object { $_.type -eq "alerting" }).Count
            Recording = @($rules | Where-Object { $_.type -eq "recording" }).Count
            Health = (@($rules | ForEach-Object { [string]$_.health } | Sort-Object -Unique) -join ",")
            LastEvaluation = $(if ($lastEvaluation.Year -le 1) { "never" } else { $lastEvaluation.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") })
        }
    }

    return [pscustomobject]@{
        Problems = $problems
        Pending = $pending
        Rows = @($rows)
        LoadedAlertCount = $loadedAlerts.Count
        ConfigLoadedAt = $load.LoadedAt
    }
}

function Assert-LoadedAtReceiver {
    param([object]$Expected, [DateTimeOffset]$EvaluatedAfter, [int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    $state = $null
    while ($true) {
        try {
            $state = Get-ReceiverState -Expected $Expected -EvaluatedAfter $EvaluatedAfter
            $lastError = $null
        } catch {
            # Prometheus may still be starting after a restart.
            $state = $null
            $lastError = $_.Exception.Message
        }
        if ($state -and $state.Problems.Count -gt 0) {
            break
        }
        if ($state -and $state.Pending.Count -eq 0) {
            break
        }
        if ((Get-Date) -ge $deadline) {
            break
        }
        Start-Sleep -Seconds 3
    }

    if (-not $state) {
        throw "VERIFICATION FAILED: Prometheus at $PrometheusUrl did not answer within $TimeoutSeconds seconds. Last error: $lastError"
    }
    if ($state.Rows.Count -gt 0) {
        $state.Rows | Format-Table -AutoSize | Out-String | Write-Host
    }
    if ($state.Problems.Count -gt 0) {
        foreach ($problem in $state.Problems) {
            Write-Step "FAIL" $problem
        }
        throw "VERIFICATION FAILED: Prometheus is not running the alert rules in $RulesFile ($($state.Problems.Count) problem(s) listed above)."
    }
    if ($state.Pending.Count -gt 0) {
        foreach ($item in $state.Pending) {
            Write-Step "FAIL" $item
        }
        throw "VERIFICATION FAILED: not every rule group evaluated with health ok within $TimeoutSeconds seconds."
    }
    Write-Step "VERIFIED" ("Prometheus holds {0} alert rules from {1} (file: {2}); configuration loaded {3:yyyy-MM-dd HH:mm:ss}; all {4} group(s) evaluated with health ok." -f $state.LoadedAlertCount, $RulesFile, $Expected.AlertNames.Count, $state.ConfigLoadedAt.ToLocalTime(), $state.Rows.Count)
}

function Test-IncomingFiles {
    # Validate the incoming commit's files in a scratch directory, so an
    # invalid rules file never lands in the checkout Prometheus restarts from.
    param([string]$Promtool, [string]$Commit)

    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("lct-alert-rules-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $scratch | Out-Null
    try {
        $archive = Join-Path $scratch "incoming.tar"
        Invoke-Git -Arguments @("archive", "--format=tar", "--output=$archive", $Commit, "--", $RulesRelative, $ConfigRelative) | Out-Null
        $extract = Invoke-Native -FilePath "tar.exe" -Arguments @("-xf", $archive, "-C", $scratch)
        if ($extract.ExitCode -ne 0) {
            throw "Could not extract the incoming rules for validation: $($extract.Output -join ' ')"
        }
        $incomingRules = Join-Path $scratch "ops\observability\prometheus-alerts.yml"
        $incomingConfig = Join-Path $scratch "ops\observability\prometheus.yml"
        return Test-RulesWithPromtool -Promtool $Promtool -Rules $incomingRules -Config $incomingConfig -Label "incoming $Commit"
    } finally {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    if (-not (Test-Path -LiteralPath $RulesFile -PathType Leaf)) {
        throw "Rules file not found: $RulesFile"
    }
    $promtool = Get-Promtool
    Write-Step "INFO" "checkout:  $RepoRoot"
    Write-Step "INFO" "promtool:  $promtool"

    if ($VerifyOnly) {
        $count = Test-RulesWithPromtool -Promtool $promtool -Rules $RulesFile -Config $ConfigFile -Label "working tree"
        $expected = Get-ExpectedRules -Rules $RulesFile -PromtoolRuleCount $count
        Write-Step "INFO" "file defines $($expected.AlertNames.Count) alert rules and $($expected.RecordingCount) recording rules"
        Assert-LoadedAtReceiver -Expected $expected -EvaluatedAfter ([DateTimeOffset]::MinValue.AddYears(1)) -TimeoutSeconds $VerifyTimeoutSeconds
        exit 0
    }

    # ---- 1. preconditions -------------------------------------------------
    $prometheusUp = $false
    $lifecycle = $false
    try {
        $flags = Get-PrometheusFlags
        $prometheusUp = $true
        $lifecycle = ([string]$flags.'web.enable-lifecycle' -eq "true")
        $runningConfig = [string]$flags.'config.file'
        if (-not (Test-SamePath -Left $runningConfig -Right $ConfigFile)) {
            throw "REFUSED: Prometheus runs with --config.file=$runningConfig, which is not in this checkout ($RepoRoot). Run this script from the checkout Prometheus reads."
        }
    } catch {
        if ($_.Exception.Message.StartsWith("REFUSED")) {
            throw
        }
        Write-Warning "Prometheus at $PrometheusUrl is not answering ($($_.Exception.Message)); cannot confirm it reads this checkout. Loading will use the restart action, which also starts it."
    }

    $currentBranch = (Invoke-Git -Arguments @("rev-parse", "--abbrev-ref", "HEAD")).Output[0].Trim()
    if ($currentBranch -ne $Branch) {
        throw "REFUSED: this checkout is on '$currentBranch', not '$Branch'. Only a fast-forward of $Branch is deployed."
    }
    $dirty = @((Invoke-Git -Arguments @("--no-optional-locks", "status", "--porcelain", "--", $RulesRelative)).Output | Where-Object { $_ })
    if ($dirty.Count -gt 0) {
        throw "REFUSED: $RulesRelative has local modifications ($($dirty -join '; ')). Commit them through a pull request or discard them first."
    }
    $configDirty = @((Invoke-Git -Arguments @("--no-optional-locks", "status", "--porcelain", "--", $ConfigRelative)).Output | Where-Object { $_ })
    if ($configDirty.Count -gt 0) {
        Write-Warning "$ConfigRelative has local modifications; Prometheus will load them as they are on disk."
    }
    $oldHead = (Invoke-Git -Arguments @("rev-parse", "HEAD")).Output[0].Trim()
    Write-Step "OK" "preconditions: on $Branch at $($oldHead.Substring(0, 9)), $RulesRelative is unmodified"

    # ---- 2. fetch and fast-forward ---------------------------------------
    $newHead = $oldHead
    $wouldChange = $false
    if ($PSCmdlet.ShouldProcess("$Remote/$Branch", "git fetch, validate the incoming rules, git merge --ff-only")) {
        Invoke-Git -Arguments @("fetch", $Remote, $Branch) | Out-Null
        $target = (Invoke-Git -Arguments @("rev-parse", "$Remote/$Branch")).Output[0].Trim()
        if ($target -eq $oldHead) {
            Write-Step "OK" "already at $Remote/$Branch ($($target.Substring(0, 9))); nothing to merge"
        } else {
            $ancestor = Invoke-Git -Arguments @("merge-base", "--is-ancestor", "HEAD", $target) -AllowFailure
            if ($ancestor.ExitCode -ne 0) {
                throw "REFUSED: $Remote/$Branch ($($target.Substring(0, 9))) is not a fast-forward of this checkout ($($oldHead.Substring(0, 9))). Resolve the divergence by hand; nothing was changed."
            }
            $incomingCount = Test-IncomingFiles -Promtool $promtool -Commit $target
            Write-Step "OK" "incoming $($target.Substring(0, 9)) validates with promtool ($incomingCount rules); checkout not touched yet"
            Invoke-Git -Arguments @("merge", "--ff-only", "$Remote/$Branch") | Out-Null
            $newHead = (Invoke-Git -Arguments @("rev-parse", "HEAD")).Output[0].Trim()
            if ($newHead -ne $target) {
                throw "git merge --ff-only finished but HEAD is $newHead, expected $target"
            }
            Write-Step "OK" "fast-forwarded $($oldHead.Substring(0, 9)) -> $($newHead.Substring(0, 9))"
        }
    } else {
        $known = Invoke-Git -Arguments @("rev-parse", "--verify", "--quiet", "$Remote/$Branch") -AllowFailure
        if ($known.ExitCode -eq 0) {
            $knownTarget = $known.Output[0].Trim()
            $differs = @((Invoke-Git -Arguments @("diff", "--name-only", $oldHead, $knownTarget, "--", $RulesRelative, $ConfigRelative)).Output | Where-Object { $_ })
            $wouldChange = ($differs.Count -gt 0)
            Write-Step "WOULD" "fetch $Remote $Branch and fast-forward to it. As of the LAST fetch (not refreshed in a dry run) $Remote/$Branch is $($knownTarget.Substring(0, 9)) and changes: $(if ($differs.Count -gt 0) { $differs -join ', ' } else { 'neither Prometheus file' })"
        } else {
            Write-Step "WOULD" "fetch $Remote $Branch and fast-forward to it ($Remote/$Branch is not known locally yet)"
        }
    }

    # ---- 3. validate what is on disk --------------------------------------
    try {
        $ruleCount = Test-RulesWithPromtool -Promtool $promtool -Rules $RulesFile -Config $ConfigFile -Label "working tree"
    } catch {
        if ($newHead -ne $oldHead) {
            Write-Step "FAIL" "The checkout was fast-forwarded to $($newHead.Substring(0, 9)) but its Prometheus files do not validate. Prometheus was NOT asked to load them and still runs the previous rules, but it would fail on its next restart. To put the last valid files back: git -C `"$RepoRoot`" checkout $oldHead -- $RulesRelative $ConfigRelative"
        }
        throw
    }
    $expected = Get-ExpectedRules -Rules $RulesFile -PromtoolRuleCount $ruleCount
    Write-Step "OK" "promtool accepts the files on disk: $($expected.AlertNames.Count) alert rules, $($expected.RecordingCount) recording rules"

    # ---- 4. make Prometheus load them --------------------------------------
    $changedByMerge = @()
    if ($newHead -ne $oldHead) {
        $changedByMerge = @((Invoke-Git -Arguments @("diff", "--name-only", $oldHead, $newHead, "--", $RulesRelative, $ConfigRelative)).Output | Where-Object { $_ })
    }
    $stale = $true
    $staleText = "Prometheus is not answering"
    if ($prometheusUp) {
        $load = Get-PrometheusConfigLoad
        $newestWrite = Get-NewestSourceWrite
        $stale = ($load.LoadedAt -lt $newestWrite) -or (-not $load.Successful)
        $staleText = "Prometheus loaded its configuration {0:yyyy-MM-dd HH:mm:ss}; files on disk last changed {1:yyyy-MM-dd HH:mm:ss}" -f $load.LoadedAt.ToLocalTime(), $newestWrite.ToLocalTime()
    }
    $needsLoad = $ForceLoad -or $stale -or ($changedByMerge.Count -gt 0) -or $wouldChange
    if ($prometheusUp -and $lifecycle) {
        $mechanism = "POST $PrometheusUrl/-/reload (Prometheus runs with --web.enable-lifecycle)"
    } else {
        $mechanism = "install_observability_tasks.ps1 -Action Restart -Component Prometheus (Prometheus runs without --web.enable-lifecycle, so there is no reload endpoint)"
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($needsLoad -and -not $elevated) {
            Write-Warning "This PowerShell is not elevated. ops/observability/README.md says the Restart action must run elevated; if the restart is refused, rerun this script from an elevated PowerShell (it will see that Prometheus is stale and load the rules)."
        }
    }

    $loadRequestedAt = [DateTimeOffset]::MinValue.AddYears(1)
    if (-not $needsLoad) {
        Write-Step "OK" "nothing to load: $staleText"
    } elseif ($PSCmdlet.ShouldProcess("Prometheus at $PrometheusUrl", "load the alert rules via $mechanism")) {
        $loadRequestedAt = [DateTimeOffset]::UtcNow
        if ($prometheusUp -and $lifecycle) {
            $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$PrometheusUrl/-/reload" -TimeoutSec 60
            if ($response.StatusCode -ne 200) {
                throw "Prometheus reload returned HTTP $($response.StatusCode)"
            }
            Write-Step "OK" "Prometheus accepted the reload"
        } else {
            & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $TaskInstaller -Action Restart -Component Prometheus | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "install_observability_tasks.ps1 -Action Restart -Component Prometheus failed with exit code $LASTEXITCODE"
            }
            Write-Step "OK" "Prometheus restarted through its scheduled task"
        }
    } else {
        Write-Step "WOULD" "load via $mechanism. $staleText"
    }

    # ---- 5. verify at the receiver -----------------------------------------
    if ($IsDryRun) {
        Write-Step "WOULD" "verify at $PrometheusUrl/api/v1/rules that exactly these $($expected.AlertNames.Count) alert rules are loaded from $RulesFile and that every group evaluated with health ok (run -VerifyOnly to check the current state)"
        Write-Step "DRYRUN" "nothing was fetched, merged or loaded"
        exit 0
    }
    Assert-LoadedAtReceiver -Expected $expected -EvaluatedAfter $loadRequestedAt -TimeoutSeconds $VerifyTimeoutSeconds
    exit 0
} catch {
    Write-Host ""
    Write-Host ("[FAIL] " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
