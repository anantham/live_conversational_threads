<#
.SYNOPSIS
Runs Claude Code's native PR review gate and writes a local review artifact.

.DESCRIPTION
This script is intentionally conservative. It uses `claude ultrareview` so Claude
Code owns PR diff/context collection instead of forcing large diffs through a
Windows command line. When `-FailOnFindings` is set, the script exits non-zero
if Claude reports findings, if Claude fails, or if the JSON schema cannot be
parsed confidently.

Generated artifacts are written under `.agent-reviews/`, which is ignored by
this repo and may contain PR context.

.EXAMPLE
.\scripts\review_pr_with_claude.ps1 134 -FailOnFindings
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Pr,

    [ValidateRange(1, 180)]
    [int]$TimeoutMinutes = 30,

    [string]$OutputDir = ".agent-reviews",

    [switch]$FailOnFindings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-CommandAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

function Get-RepoRoot {
    $root = (& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($root)) {
        throw "Run this script from inside a Git checkout."
    }
    return $root.Trim()
}

function New-SafeSlug {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return ($Value -replace '[^A-Za-z0-9_.-]+', '-').Trim('-')
}

function Get-EnumerableCount {
    param([object]$Value)

    if ($null -eq $Value -or $Value -is [string]) {
        return $null
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        return @($Value).Count
    }

    return $null
}

function Get-ReviewFindingCount {
    param([object]$Payload)

    $findingPropertyNames = @(
        "bugs",
        "findings",
        "issues",
        "errors",
        "vulnerabilities"
    )

    $counts = New-Object System.Collections.Generic.List[int]

    function Visit-Node {
        param([object]$Node)

        if ($null -eq $Node -or $Node -is [string]) {
            return
        }

        if ($Node -is [pscustomobject]) {
            foreach ($property in $Node.PSObject.Properties) {
                $propertyName = $property.Name.ToLowerInvariant()
                $propertyValue = $property.Value

                if ($findingPropertyNames -contains $propertyName) {
                    $count = Get-EnumerableCount $propertyValue
                    if ($null -ne $count) {
                        $counts.Add([int]$count) | Out-Null
                    }
                }

                Visit-Node $propertyValue
            }
            return
        }

        if ($Node -is [System.Collections.IDictionary]) {
            foreach ($key in $Node.Keys) {
                $propertyName = ([string]$key).ToLowerInvariant()
                $propertyValue = $Node[$key]

                if ($findingPropertyNames -contains $propertyName) {
                    $count = Get-EnumerableCount $propertyValue
                    if ($null -ne $count) {
                        $counts.Add([int]$count) | Out-Null
                    }
                }

                Visit-Node $propertyValue
            }
            return
        }

        if ($Node -is [System.Collections.IEnumerable]) {
            foreach ($item in $Node) {
                Visit-Node $item
            }
        }
    }

    Visit-Node $Payload

    if ($counts.Count -eq 0) {
        return $null
    }

    return ($counts | Measure-Object -Sum).Sum
}

Assert-CommandAvailable git
Assert-CommandAvailable gh
Assert-CommandAvailable claude

$repoRoot = Get-RepoRoot
Set-Location -LiteralPath $repoRoot

$outputRoot = Join-Path $repoRoot $OutputDir
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$slug = New-SafeSlug $Pr
$rawPath = Join-Path $outputRoot "pr-$slug-claude-ultrareview-$timestamp.json"
$summaryPath = Join-Path $outputRoot "pr-$slug-claude-ultrareview-$timestamp.md"

Write-Host "Running Claude ultrareview for PR '$Pr' with timeout ${TimeoutMinutes}m..."
$reviewOutput = & claude ultrareview $Pr --timeout $TimeoutMinutes --json 2>&1
$claudeExit = $LASTEXITCODE
$raw = ($reviewOutput | Out-String).Trim()

if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = "<no output>"
}

Set-Content -LiteralPath $rawPath -Value $raw -Encoding UTF8

$findingCount = $null
$parseStatus = "parsed"

try {
    $payload = $raw | ConvertFrom-Json -ErrorAction Stop
    $findingCount = Get-ReviewFindingCount $payload
    if ($null -eq $findingCount) {
        $parseStatus = "parsed, but finding-count schema was not recognized"
    }
}
catch {
    $parseStatus = "failed to parse Claude JSON: $($_.Exception.Message)"
}

$summaryLines = @(
    "# Claude PR review gate",
    "",
    "- PR: $Pr",
    "- Generated: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')",
    "- Command: claude ultrareview $Pr --timeout $TimeoutMinutes --json",
    "- Claude exit code: $claudeExit",
    "- Parse status: $parseStatus",
    "- Finding count: $(if ($null -eq $findingCount) { 'unknown' } else { $findingCount })",
    "- Raw artifact: $rawPath",
    "",
    "## Gate result",
    ""
)

if ($claudeExit -ne 0) {
    $summaryLines += "DO NOT MERGE: Claude review command failed. Inspect the raw artifact."
}
elseif ($null -eq $findingCount) {
    $summaryLines += "HUMAN REVIEW REQUIRED: Claude returned JSON, but this script could not confidently count findings."
}
elseif ($findingCount -gt 0) {
    $summaryLines += "DO NOT MERGE YET: Claude reported $findingCount finding(s). Inspect the raw artifact."
}
else {
    $summaryLines += "MERGE GATE PASSED: Claude reported zero findings."
}

Set-Content -LiteralPath $summaryPath -Value $summaryLines -Encoding UTF8

Write-Host "Claude review summary: $summaryPath"
Write-Host "Claude review raw JSON: $rawPath"

if ($claudeExit -ne 0) {
    Write-Error "Claude review command failed with exit code $claudeExit."
    exit $claudeExit
}

if ($FailOnFindings) {
    if ($null -eq $findingCount) {
        Write-Error "Refusing to pass merge gate because Claude's JSON schema was not confidently parsed."
        exit 3
    }

    if ($findingCount -gt 0) {
        Write-Error "Refusing to pass merge gate because Claude reported $findingCount finding(s)."
        exit 4
    }
}

exit 0
