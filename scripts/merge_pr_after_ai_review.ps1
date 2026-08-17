<# Merges only after an explicitly selected independent-family review passes. #>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, Position = 0)] [string]$Pr,
    [Parameter(Mandatory = $true)]
    [ValidateSet("grok", "claude")] [string]$Provider,
    [ValidateSet("squash", "merge", "rebase")] [string]$Method = "squash",
    [ValidateRange(1, 180)] [int]$TimeoutMinutes = 30,
    [switch]$DeleteBranch,
    [switch]$SkipChecks,
    [switch]$ConfirmMerge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $ConfirmMerge) {
    throw "Refusing to merge without -ConfirmMerge. Merging main can ship production."
}
$repoRoot = (& git rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    throw "Run this script from inside a Git checkout."
}
Set-Location -LiteralPath $repoRoot
$reviewScript = Join-Path $repoRoot "scripts/review_pr_with_independent_ai.ps1"
if (-not (Test-Path -LiteralPath $reviewScript)) { throw "Missing review gate: $reviewScript" }

Write-Host "Step 1/3: running $Provider independent-family review gate..."
& $reviewScript $Pr -Provider $Provider -TimeoutMinutes $TimeoutMinutes -FailOnFindings
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipChecks) {
    Write-Host "Step 2/3: waiting for GitHub checks..."
    & gh pr checks $Pr --watch --fail-fast
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else { Write-Warning "Skipping GitHub checks because -SkipChecks was provided." }

$mergeArgs = @("pr", "merge", $Pr, "--$Method")
if ($DeleteBranch) { $mergeArgs += "--delete-branch" }
Write-Host "Step 3/3: merging PR '$Pr' with method '$Method'..."
if ($PSCmdlet.ShouldProcess("PR $Pr", "gh $($mergeArgs -join ' ')")) {
    & gh @mergeArgs
    exit $LASTEXITCODE
}
