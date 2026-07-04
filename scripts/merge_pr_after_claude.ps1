<#
.SYNOPSIS
Merges a GitHub PR only after the Claude review gate passes.

.DESCRIPTION
This wrapper enforces the local project rule that PRs targeting main must get a
Claude review first. It intentionally requires `-ConfirmMerge` because merging
to main ships the frontend through Vercel in this repo.

.EXAMPLE
.\scripts\merge_pr_after_claude.ps1 134 -ConfirmMerge
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Pr,

    [ValidateSet("squash", "merge", "rebase")]
    [string]$Method = "squash",

    [ValidateRange(1, 180)]
    [int]$TimeoutMinutes = 30,

    [switch]$DeleteBranch,

    [switch]$SkipChecks,

    [switch]$ConfirmMerge
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

if (-not $ConfirmMerge) {
    throw "Refusing to merge without -ConfirmMerge. In this repo, merging main can ship production."
}

Assert-CommandAvailable git
Assert-CommandAvailable gh
Assert-CommandAvailable claude

$repoRoot = Get-RepoRoot
Set-Location -LiteralPath $repoRoot

$reviewScript = Join-Path $repoRoot "scripts\review_pr_with_claude.ps1"
if (-not (Test-Path -LiteralPath $reviewScript)) {
    throw "Missing review gate script: $reviewScript"
}

Write-Host "Step 1/3: running Claude review gate..."
& $reviewScript $Pr -TimeoutMinutes $TimeoutMinutes -FailOnFindings
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if (-not $SkipChecks) {
    Write-Host "Step 2/3: waiting for GitHub checks..."
    & gh pr checks $Pr --watch --fail-fast
    if ($LASTEXITCODE -ne 0) {
        Write-Error "GitHub checks failed or did not complete cleanly."
        exit $LASTEXITCODE
    }
}
else {
    Write-Warning "Skipping GitHub checks because -SkipChecks was provided."
}

$mergeArgs = @("pr", "merge", $Pr)
switch ($Method) {
    "squash" { $mergeArgs += "--squash" }
    "merge" { $mergeArgs += "--merge" }
    "rebase" { $mergeArgs += "--rebase" }
}

if ($DeleteBranch) {
    $mergeArgs += "--delete-branch"
}

Write-Host "Step 3/3: merging PR '$Pr' with method '$Method'..."
if ($PSCmdlet.ShouldProcess("PR $Pr", "gh $($mergeArgs -join ' ')")) {
    & gh @mergeArgs
    exit $LASTEXITCODE
}
