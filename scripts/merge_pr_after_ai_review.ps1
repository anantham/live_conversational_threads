<# Merges only after an explicitly selected independent-family review passes. #>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, Position = 0)] [string]$Pr,
    [Parameter(Mandatory = $true)]
    [ValidateSet("grok", "claude", "gemini")] [string]$Provider,
    [string]$ReviewArtifact,
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
if ($Provider -eq 'gemini' -and $SkipChecks) {
    throw 'Gemini receipt merges require GitHub checks; -SkipChecks is unavailable.'
}
$repoRoot = (& git rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    throw "Run this script from inside a Git checkout."
}
Set-Location -LiteralPath $repoRoot
$reviewScript = Join-Path $repoRoot "scripts/review_pr_with_independent_ai.ps1"
if (-not (Test-Path -LiteralPath $reviewScript)) { throw "Missing review gate: $reviewScript" }

function Get-PrIdentity {
    $raw = (& gh pr view $Pr --json number,baseRefName,baseRefOid,headRefOid 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read PR identity: $raw" }
    $identity = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($identity.headRefOid -cnotmatch '^[0-9a-f]{40}$' -or
        $identity.baseRefOid -cnotmatch '^[0-9a-f]{40}$') { throw 'PR identity lacked full commit SHAs.' }
    return $identity
}

$reviewedIdentity = Get-PrIdentity

Write-Host "Step 1/3: running $Provider independent-family review gate..."
& $reviewScript $Pr -Provider $Provider -ReviewArtifact $ReviewArtifact -TimeoutMinutes $TimeoutMinutes -FailOnFindings
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$afterReview = Get-PrIdentity
if ($afterReview.number -ne $reviewedIdentity.number -or
    $afterReview.baseRefName -cne $reviewedIdentity.baseRefName -or
    $afterReview.baseRefOid -cne $reviewedIdentity.baseRefOid -or
    $afterReview.headRefOid -cne $reviewedIdentity.headRefOid) {
    throw 'PR base or head changed during review; refusing merge.'
}

if (-not $SkipChecks) {
    Write-Host "Step 2/3: waiting for GitHub checks..."
    & gh pr checks $Pr --watch --fail-fast
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else { Write-Warning "Skipping GitHub checks because -SkipChecks was provided." }

$beforeMerge = Get-PrIdentity
if ($beforeMerge.number -ne $reviewedIdentity.number -or
    $beforeMerge.baseRefName -cne $reviewedIdentity.baseRefName -or
    $beforeMerge.baseRefOid -cne $reviewedIdentity.baseRefOid -or
    $beforeMerge.headRefOid -cne $reviewedIdentity.headRefOid) {
    throw 'PR base or head changed while waiting for checks; refusing merge.'
}

$mergeArgs = @("pr", "merge", $Pr, "--$Method", "--match-head-commit", $reviewedIdentity.headRefOid)
if ($DeleteBranch) { $mergeArgs += "--delete-branch" }
Write-Host "Step 3/3: merging PR '$Pr' with method '$Method'..."
if ($PSCmdlet.ShouldProcess("PR $Pr", "gh $($mergeArgs -join ' ')")) {
    & gh @mergeArgs
    exit $LASTEXITCODE
}
