Set-StrictMode -Version Latest

function Get-NormalizedObservabilityRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd("\") + "\"
}

function Test-ObservabilityGrafanaPluginOwnership {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$ProcessPath,
        [Parameter(Mandatory = $true)][string]$ProcessName
    )

    $root = Get-NormalizedObservabilityRoot -Path $RuntimeRoot
    $fullProcessPath = [IO.Path]::GetFullPath($ProcessPath)
    $pathProcessName = [IO.Path]::GetFileNameWithoutExtension($fullProcessPath)
    if (-not $pathProcessName.Equals($ProcessName, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    if (-not $ProcessName.StartsWith("gpx_grafana", [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    $externalPluginRoot = $root + "grafana-plugins\"
    if ($fullProcessPath.StartsWith($externalPluginRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $bundledBinRoot = $root + "bin\"
    if (-not $fullProcessPath.StartsWith($bundledBinRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    $relativePath = $fullProcessPath.Substring($bundledBinRoot.Length)
    $segments = @($relativePath.Split("\", [StringSplitOptions]::RemoveEmptyEntries))
    if ($segments.Count -lt 2 -or -not $segments[0].StartsWith("grafana-", [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    return $relativePath.IndexOf("\data\plugins-bundled\", [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-ObservabilityGrafanaPluginProcesses {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)

    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        try {
            $processPath = $process.Path
        } catch {
            continue
        }
        if (-not $processPath) {
            continue
        }
        if (Test-ObservabilityGrafanaPluginOwnership `
                -RuntimeRoot $RuntimeRoot `
                -ProcessPath $processPath `
                -ProcessName $process.ProcessName) {
            [pscustomobject][ordered]@{
                process_id = $process.Id
                process_name = $process.ProcessName
                process_path = [IO.Path]::GetFullPath($processPath)
            }
        }
    }
}

function Stop-ObservabilityOrphanedGrafanaPluginProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [ValidateRange(1, 60)][int]$TimeoutSeconds = 20
    )

    $owned = @(Get-ObservabilityGrafanaPluginProcesses -RuntimeRoot $RuntimeRoot)
    if ($owned.Count -eq 0) {
        return 0
    }

    $groups = @($owned | Group-Object process_name | Sort-Object Name)
    Write-Host "[STOP] $($owned.Count) orphaned Grafana plugin helper(s) across $($groups.Count) executable(s) under $RuntimeRoot"
    foreach ($group in $groups) {
        Write-Host "       $($group.Count)x $($group.Name)"
    }

    foreach ($candidate in $owned) {
        $current = Get-Process -Id $candidate.process_id -ErrorAction SilentlyContinue
        if (-not $current) {
            continue
        }
        try {
            $currentPath = $current.Path
        } catch {
            throw "Cannot revalidate Grafana plugin helper PID $($candidate.process_id) before stopping it"
        }
        if (-not (Test-ObservabilityGrafanaPluginOwnership `
                -RuntimeRoot $RuntimeRoot `
                -ProcessPath $currentPath `
                -ProcessName $current.ProcessName)) {
            throw "PID $($candidate.process_id) changed ownership before Grafana plugin cleanup; refusing to stop it"
        }
        try {
            Stop-Process -Id $candidate.process_id -Force -ErrorAction Stop
        } catch {
            if (Get-Process -Id $candidate.process_id -ErrorAction SilentlyContinue) {
                throw
            }
        }
    }

    $candidateIds = @($owned | Select-Object -ExpandProperty process_id)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(Get-ObservabilityGrafanaPluginProcesses -RuntimeRoot $RuntimeRoot |
            Where-Object { $_.process_id -in $candidateIds })
        if ($remaining.Count -eq 0) {
            Write-Host "[STOP] Grafana plugin helper cleanup complete"
            return $owned.Count
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    $sample = @($remaining | Select-Object -First 10 | ForEach-Object {
        "PID $($_.process_id) $($_.process_path)"
    })
    $additional = [Math]::Max(0, $remaining.Count - $sample.Count)
    throw "Grafana plugin helper cleanup timed out after $TimeoutSeconds seconds: count=$($remaining.Count); sample=$($sample -join '; '); additional=$additional"
}

function Assert-NoRuntimeProcesses {
    param([Parameter(Mandatory = $true)][string[]]$Roots)

    $normalizedRoots = @($Roots | Where-Object { $_ } | ForEach-Object {
        Get-NormalizedObservabilityRoot -Path $_
    } | Select-Object -Unique)
    $remaining = @()
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        try {
            $processPath = $process.Path
        } catch {
            continue
        }
        if (-not $processPath) {
            continue
        }
        $fullProcessPath = [IO.Path]::GetFullPath($processPath)
        foreach ($root in $normalizedRoots) {
            if ($fullProcessPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                $remaining += [pscustomobject][ordered]@{
                    process_id = $process.Id
                    process_path = $fullProcessPath
                }
                break
            }
        }
    }
    if ($remaining.Count -eq 0) {
        return
    }

    $sample = @($remaining | Select-Object -First 10 | ForEach-Object {
        "PID $($_.process_id) $($_.process_path)"
    })
    $additional = [Math]::Max(0, $remaining.Count - $sample.Count)
    throw "Runtime process gate failed after controlled stop: count=$($remaining.Count); sample=$($sample -join '; '); additional=$additional. Refusing copy or rename."
}

Export-ModuleMember -Function @(
    "Test-ObservabilityGrafanaPluginOwnership",
    "Get-ObservabilityGrafanaPluginProcesses",
    "Stop-ObservabilityOrphanedGrafanaPluginProcesses",
    "Assert-NoRuntimeProcesses"
)
