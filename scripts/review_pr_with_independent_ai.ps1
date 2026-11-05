<#
.SYNOPSIS
Runs a fail-closed PR review with an explicitly selected independent AI family.

.DESCRIPTION
The caller is responsible for choosing a provider family different from the
family that primarily implemented the PR. Grok receives a bounded PR packet
(metadata + exact diff) and may read the checkout in plan mode. Claude delegates
to the established native ultrareview adapter. Gemini validates a trusted
receipt from a completed review against the current PR; it does not invoke a
provider or infer a new review.

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
    [ValidateSet("grok", "claude", "gemini")]
    [string]$Provider,

    [string]$ReviewArtifact,

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

function Assert-Fields($Object, [string[]]$Required, [string[]]$Optional = @()) {
    if ($null -eq $Object -or $Object -isnot [pscustomobject]) { throw "Review receipt has an invalid object." }
    $names = @($Object.PSObject.Properties.Name)
    foreach ($name in $Required) {
        if ($names -cnotcontains $name) { throw "Review receipt is missing '$name'." }
    }
    foreach ($name in $names) {
        if ($Required -cnotcontains $name -and $Optional -cnotcontains $name) {
            throw "Review receipt has unknown field '$name'."
        }
    }
}

function Assert-PositiveInt($Value, [string]$Name) {
    if ($Value -isnot [int] -and $Value -isnot [long]) { throw "Review receipt $Name must be an integer." }
    if ($Value -le 0) { throw "Review receipt $Name must be positive." }
}

function Assert-Sha([string]$Value, [string]$Name) {
    if ($Value -cnotmatch '^[0-9a-f]{40}$') { throw "Review receipt $Name must be a lowercase full Git SHA." }
}

function Assert-GeminiReceipt([string]$Path, [string]$PrIdentifier) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "Gemini requires -ReviewArtifact from a completed review." }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Review artifact not found: $Path" }
    $receipt = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    Assert-Fields $receipt @('schemaVersion','provider','family','model','pr','source','review')
    Assert-Fields $receipt.pr @('number','baseRefName','baseRefOid','headRefOid')
    Assert-Fields $receipt.source @('commitRange','files','excludedFiles','outgoingBytes','sha256') @('packetBytes','packetSha256')
    Assert-Fields $receipt.review @('verdict','findings','status','exitCode','toolAttempts')
    if (($receipt.schemaVersion -isnot [int] -and $receipt.schemaVersion -isnot [long]) -or $receipt.schemaVersion -ne 1 -or
        $receipt.provider -cne 'gemini' -or $receipt.family -cne 'Google Gemini' -or
        $receipt.model -cne 'gemini-3.8-flash-high') { throw 'Unsupported Gemini review receipt identity/schema.' }
    if ($receipt.review.verdict -cne 'APPROVED' -or $receipt.review.status -cne 'SUCCESS' -or
        ($receipt.review.exitCode -isnot [int] -and $receipt.review.exitCode -isnot [long]) -or $receipt.review.exitCode -ne 0 -or
        ($receipt.review.toolAttempts -isnot [int] -and $receipt.review.toolAttempts -isnot [long]) -or $receipt.review.toolAttempts -ne 0 -or
        $receipt.review.findings -isnot [array] -or $receipt.review.findings.Count -ne 0) {
        throw 'Gemini review receipt does not attest a successful, tool-free, finding-free review.'
    }
    Assert-PositiveInt $receipt.source.outgoingBytes 'source.outgoingBytes'
    if ([string]$receipt.source.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid outgoing SHA-256.' }
    if ($receipt.source.PSObject.Properties.Name -contains 'packetBytes') { Assert-PositiveInt $receipt.source.packetBytes 'source.packetBytes' }
    if ($receipt.source.PSObject.Properties.Name -contains 'packetSha256' -and
        [string]$receipt.source.packetSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid packet SHA-256.' }
    Assert-Sha ([string]$receipt.pr.baseRefOid) 'pr.baseRefOid'
    Assert-Sha ([string]$receipt.pr.headRefOid) 'pr.headRefOid'
    if (($receipt.pr.number -isnot [int] -and $receipt.pr.number -isnot [long]) -or $receipt.pr.number -le 0 -or
        [string]$receipt.pr.baseRefName -cne 'main' -or
        [string]$receipt.source.commitRange -cne "$($receipt.pr.baseRefOid)..$($receipt.pr.headRefOid)") {
        throw 'Gemini review receipt has an invalid PR identity or commit range.'
    }
    if ($PrIdentifier -match '^\d+$') { $requestedNumber = [int]$PrIdentifier }
    elseif ($PrIdentifier -match '/pull/(\d+)(?:/?$|[?#])') { $requestedNumber = [int]$Matches[1] }
    else { throw 'Gemini receipt route requires a PR number or pull URL.' }
    if ($receipt.pr.number -ne $requestedNumber) { throw 'Review receipt is for another PR.' }

    $metadataRaw = (& gh pr view $PrIdentifier --json number,baseRefName,baseRefOid,headRefOid,files 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read fresh PR metadata: $metadataRaw" }
    $metadata = $metadataRaw | ConvertFrom-Json -ErrorAction Stop
    if ($metadata.number -ne $receipt.pr.number -or
        [string]$metadata.baseRefName -cne [string]$receipt.pr.baseRefName -or
        [string]$metadata.baseRefOid -cne [string]$receipt.pr.baseRefOid -or
        [string]$metadata.headRefOid -cne [string]$receipt.pr.headRefOid) {
        throw 'Review receipt is stale against the current PR base or head.'
    }
    if ($receipt.source.files -isnot [array] -or $receipt.source.files.Count -eq 0 -or
        $receipt.source.excludedFiles -isnot [array]) { throw 'Review receipt source inventory is malformed.' }
    $allowedExclusions = @(
        'ISSUES.md','docs/WORKLOG.md','docs/TECH_DEBT.md',
        'docs/reviews/complete-passage-coverage-2026-10-14.json',
        'docs/reviews/credential-containment-2026-10-14.json',
        'docs/reviews/semantic-release-checkpoint-2026-10-14.json',
        'docs/reviews/viewer-release-progress-2026-10-14.json',
        'docs/reviews/viewer-release-independent-2026-10-14.json'
    )
    $inventory = [System.Collections.Generic.List[string]]::new()
    foreach ($file in $receipt.source.files) {
        if ($file -isnot [string] -or [string]::IsNullOrWhiteSpace($file)) { throw 'Invalid reviewed file path.' }
        $inventory.Add($file)
    }
    foreach ($item in $receipt.source.excludedFiles) {
        Assert-Fields $item @('path','reason')
        if ($item.path -isnot [string] -or $allowedExclusions -cnotcontains $item.path -or
            $item.reason -isnot [string] -or [string]::IsNullOrWhiteSpace($item.reason)) {
            throw 'Review receipt attempts an unapproved source exclusion.'
        }
        $inventory.Add($item.path)
    }
    $actualFiles = @($metadata.files | ForEach-Object { [string]$_.path })
    if (@($inventory | Select-Object -Unique).Count -ne $inventory.Count -or
        @($actualFiles | Select-Object -Unique).Count -ne $actualFiles.Count -or
        $inventory.Count -ne $actualFiles.Count -or
        @(Compare-Object -ReferenceObject @($actualFiles | Sort-Object -CaseSensitive) -DifferenceObject @($inventory | Sort-Object -CaseSensitive) -CaseSensitive).Count -ne 0) {
        throw 'Review receipt file inventory differs from the current PR files.'
    }
    Write-Host "MERGE GATE PASSED: Gemini receipt approves PR '$requestedNumber' at exact head '$($receipt.pr.headRefOid)' with zero findings."
}

Assert-CommandAvailable git
Assert-CommandAvailable gh
$repoRoot = Get-RepoRoot
Set-Location -LiteralPath $repoRoot

if ($Provider -eq 'gemini') {
    Assert-GeminiReceipt $ReviewArtifact $Pr
    exit 0
}
if (-not [string]::IsNullOrWhiteSpace($ReviewArtifact)) { throw '-ReviewArtifact is only supported for Gemini.' }

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
