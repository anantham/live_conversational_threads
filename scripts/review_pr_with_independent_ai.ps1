<#
.SYNOPSIS
Runs a fail-closed PR review with an explicitly selected independent AI family.

.DESCRIPTION
The caller is responsible for choosing a provider family different from the
family that primarily implemented the PR. Grok receives a bounded PR packet
(metadata + exact diff) and may read the checkout in plan mode. Claude delegates
to the established native ultrareview adapter.

Test intent:
- provider choice is explicit, never silently defaulted;
- the artifact records provider and exact head SHA;
- Grok stderr telemetry cannot corrupt the structured stdout JSON;
- an outer CLI envelope exposes its `structuredOutput` as the gate payload;
- findings, command failures, and unrecognized schemas fail closed.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Pr,

    [Parameter(Mandatory = $true)]
    [ValidateSet("grok", "claude")]
    [string]$Provider,

    [ValidateRange(1, 180)]
    [int]$TimeoutMinutes = 30,

    [string]$OutputDir = ".agent-reviews",

    [switch]$FailOnFindings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-CommandAvailable([string]$Name) {
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

function ConvertFrom-ReviewJson([string]$Raw) {
    try { return $Raw | ConvertFrom-Json -ErrorAction Stop }
    catch {
        $first = $Raw.IndexOf('{')
        $last = $Raw.LastIndexOf('}')
        if ($first -lt 0 -or $last -le $first) { throw }
        return $Raw.Substring($first, $last - $first + 1) |
            ConvertFrom-Json -ErrorAction Stop
    }
}

Assert-CommandAvailable git
Assert-CommandAvailable gh
$repoRoot = Get-RepoRoot
Set-Location -LiteralPath $repoRoot

if ($Provider -eq "claude") {
    $adapter = Join-Path $repoRoot "scripts/review_pr_with_claude.ps1"
    if (-not (Test-Path -LiteralPath $adapter)) { throw "Missing Claude adapter: $adapter" }
    & $adapter $Pr -TimeoutMinutes $TimeoutMinutes -OutputDir $OutputDir -FailOnFindings:$FailOnFindings
    exit $LASTEXITCODE
}

Assert-CommandAvailable grok
$outputRoot = Join-Path $repoRoot $OutputDir
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$slug = ($Pr -replace '[^A-Za-z0-9_.-]+', '-').Trim('-')
$metadata = (& gh pr view $Pr --json number,title,body,url,baseRefName,headRefName,headRefOid,files 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not read PR metadata: $metadata" }
$diff = (& gh pr diff $Pr 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not read PR diff: $diff" }
$metaPayload = $metadata | ConvertFrom-Json -ErrorAction Stop
$headSha = [string]$metaPayload.headRefOid

$promptPath = Join-Path $outputRoot "pr-$slug-grok-review-$timestamp.prompt.md"
$rawPath = Join-Path $outputRoot "pr-$slug-grok-review-$timestamp.json"
$stderrPath = Join-Path $outputRoot "pr-$slug-grok-review-$timestamp.stderr.log"
$summaryPath = Join-Path $outputRoot "pr-$slug-grok-review-$timestamp.md"
$prompt = @"
You are the independent adversarial reviewer for GitHub PR $Pr at exact head $headSha.
Do not modify files. Inspect the supplied metadata and diff, and read repository files
only when needed to validate behavior. Report only concrete, reproducible defects
introduced by this PR; do not report style preferences or pre-existing issues.
For every finding provide severity, file, line, title, explanation, and a falsifiable
reproduction/test. Return the required JSON object. An empty findings array means pass.

PR METADATA
$metadata

EXACT PR DIFF
$diff
"@
Set-Content -LiteralPath $promptPath -Value $prompt -Encoding UTF8

$schema = '{"type":"object","properties":{"verdict":{"type":"string","enum":["pass","findings"]},"findings":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string"},"file":{"type":"string"},"line":{"type":"integer"},"title":{"type":"string"},"explanation":{"type":"string"},"reproduction":{"type":"string"}},"required":["severity","file","line","title","explanation","reproduction"],"additionalProperties":false}}},"required":["verdict","findings"],"additionalProperties":false}'
Write-Host "Running Grok independent review for PR '$Pr' at '$headSha'..."
$reviewOutput = & grok --cwd $repoRoot --permission-mode plan --disable-web-search --no-subagents --max-turns 30 --json-schema $schema --prompt-file $promptPath 2> $stderrPath
$reviewExit = $LASTEXITCODE
$raw = ($reviewOutput | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($raw)) { $raw = "<no output>" }
Set-Content -LiteralPath $rawPath -Value $raw -Encoding UTF8

$payload = $null
$parseStatus = "parsed"
$findingCount = $null
try {
    $payload = ConvertFrom-ReviewJson $raw
    if ($payload.PSObject.Properties.Name -contains "structuredOutput") {
        $payload = $payload.structuredOutput
        if ($payload -is [string]) {
            $payload = ConvertFrom-ReviewJson $payload
        }
    }
    if ($null -eq $payload.findings -or $payload.verdict -notin @("pass", "findings")) {
        throw "Required verdict/findings schema was not present."
    }
    $findingCount = @($payload.findings).Count
    if (($payload.verdict -eq "pass" -and $findingCount -ne 0) -or
        ($payload.verdict -eq "findings" -and $findingCount -eq 0)) {
        throw "Verdict and finding count disagree."
    }
}
catch { $parseStatus = "unrecognized: $($_.Exception.Message)" }

$gate = if ($reviewExit -ne 0) {
    "DO NOT MERGE: Grok review command failed."
} elseif ($null -eq $findingCount) {
    "HUMAN REVIEW REQUIRED: Grok output schema was not confidently parsed."
} elseif ($findingCount -gt 0) {
    "DO NOT MERGE YET: Grok reported $findingCount finding(s)."
} else {
    "MERGE GATE PASSED: Grok reported zero findings."
}
$summary = @(
    "# Independent AI PR review gate", "",
    "- PR: $Pr", "- Provider/family: grok/xAI", "- Exact head SHA: $headSha",
    "- Generated: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')",
    "- Exit code: $reviewExit", "- Parse status: $parseStatus",
    "- Finding count: $(if ($null -eq $findingCount) { 'unknown' } else { $findingCount })",
    "- Raw stdout artifact: $rawPath", "- Stderr diagnostics: $stderrPath",
    "", "## Gate result", "", $gate
)
Set-Content -LiteralPath $summaryPath -Value $summary -Encoding UTF8
Write-Host "Independent review summary: $summaryPath"
Write-Host "Independent review raw JSON: $rawPath"

if ($reviewExit -ne 0) { exit $reviewExit }
if ($FailOnFindings -and $null -eq $findingCount) { exit 3 }
if ($FailOnFindings -and $findingCount -gt 0) { exit 4 }
exit 0
