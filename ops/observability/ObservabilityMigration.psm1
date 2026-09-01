Set-StrictMode -Version Latest

function ConvertTo-ObservabilityFullPath {
    param([Parameter(Mandatory)][string]$Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd("\")
}

function Write-ObservabilityJournalFile {
    param([Parameter(Mandatory)]$Descriptor)

    $journalPath = ConvertTo-ObservabilityFullPath -Path $Descriptor.journal_path
    $journalRoot = Split-Path -Parent $journalPath
    if (-not (Test-Path -LiteralPath $journalRoot -PathType Container)) {
        throw "Migration journal directory is missing: $journalRoot"
    }

    $Descriptor.updated_at = (Get-Date).ToUniversalTime().ToString("o")
    $temporaryPath = "$journalPath.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    $json = $Descriptor | ConvertTo-Json -Depth 5
    try {
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $journalPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function New-ObservabilityMigrationDescriptor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LiveRoot,
        [Parameter(Mandatory)][string]$JournalRoot,
        [Guid]$RunId = [Guid]::NewGuid()
    )

    $live = ConvertTo-ObservabilityFullPath -Path $LiveRoot
    $journalDirectory = ConvertTo-ObservabilityFullPath -Path $JournalRoot
    $parent = Split-Path -Parent $live
    $name = Split-Path -Leaf $live
    $token = $RunId.ToString("N")

    return [pscustomobject][ordered]@{
        schema_version = 1
        run_id = $RunId.ToString()
        state = "planned"
        live_root = $live
        stage_root = Join-Path $parent "$name.stage-$token"
        rollback_root = Join-Path $parent "$name.rollback-$token"
        failed_live_root = Join-Path $parent "$name.failed-live-$token"
        failed_stage_root = Join-Path $parent "$name.failed-stage-$token"
        journal_path = Join-Path $journalDirectory "migration-$token.json"
        created_at = (Get-Date).ToUniversalTime().ToString("o")
        updated_at = $null
    }
}

function Write-ObservabilityMigrationJournal {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Descriptor)

    Write-ObservabilityJournalFile -Descriptor $Descriptor
}

function Read-ObservabilityMigrationJournal {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $journalPath = ConvertTo-ObservabilityFullPath -Path $Path
    try {
        $descriptor = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Migration journal is unreadable at $journalPath`: $($_.Exception.Message)"
    }
    if ($descriptor.schema_version -ne 1 -or -not $descriptor.run_id -or -not $descriptor.state) {
        throw "Migration journal has an unsupported or incomplete schema: $journalPath"
    }
    return $descriptor
}

function Set-ObservabilityMigrationState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Descriptor,
        [Parameter(Mandatory)][string]$State
    )

    $Descriptor.state = $State
    Write-ObservabilityJournalFile -Descriptor $Descriptor
}

function Move-ObservabilityDirectory {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$Purpose
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "$Purpose source directory is missing: $Source"
    }
    if (Test-Path -LiteralPath $Destination) {
        throw "$Purpose destination already exists; refusing to overwrite it: $Destination"
    }
    [IO.Directory]::Move(
        (ConvertTo-ObservabilityFullPath -Path $Source),
        (ConvertTo-ObservabilityFullPath -Path $Destination)
    )
}

function Invoke-ObservabilityRuntimePromotion {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Descriptor)

    foreach ($path in @(
        $Descriptor.rollback_root,
        $Descriptor.failed_live_root,
        $Descriptor.failed_stage_root
    )) {
        if (Test-Path -LiteralPath $path) {
            throw "Promotion destination already exists; refusing to overwrite it: $path"
        }
    }

    Set-ObservabilityMigrationState -Descriptor $Descriptor -State "swap_live_pending"
    Move-ObservabilityDirectory `
        -Source $Descriptor.live_root `
        -Destination $Descriptor.rollback_root `
        -Purpose "Retain prior runtime"

    Set-ObservabilityMigrationState -Descriptor $Descriptor -State "swap_stage_pending"
    Move-ObservabilityDirectory `
        -Source $Descriptor.stage_root `
        -Destination $Descriptor.live_root `
        -Purpose "Promote staged runtime"

    Set-ObservabilityMigrationState -Descriptor $Descriptor -State "promoted"
}

function Restore-ObservabilityRuntime {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Descriptor)

    Set-ObservabilityMigrationState -Descriptor $Descriptor -State "rollback_pending"
    $liveExists = Test-Path -LiteralPath $Descriptor.live_root -PathType Container
    $stageExists = Test-Path -LiteralPath $Descriptor.stage_root -PathType Container
    $rollbackExists = Test-Path -LiteralPath $Descriptor.rollback_root -PathType Container

    if ($rollbackExists) {
        if ($liveExists) {
            Move-ObservabilityDirectory `
                -Source $Descriptor.live_root `
                -Destination $Descriptor.failed_live_root `
                -Purpose "Retain failed promoted runtime"
        }
        if ($stageExists) {
            Move-ObservabilityDirectory `
                -Source $Descriptor.stage_root `
                -Destination $Descriptor.failed_stage_root `
                -Purpose "Retain interrupted staged runtime"
        }
        Move-ObservabilityDirectory `
            -Source $Descriptor.rollback_root `
            -Destination $Descriptor.live_root `
            -Purpose "Restore prior runtime"
    } else {
        if (-not $liveExists) {
            throw "Cannot recover migration $($Descriptor.run_id): both live and rollback runtimes are missing"
        }
        if ($stageExists) {
            Move-ObservabilityDirectory `
                -Source $Descriptor.stage_root `
                -Destination $Descriptor.failed_stage_root `
                -Purpose "Retain unpromoted staged runtime"
        }
    }

    Set-ObservabilityMigrationState -Descriptor $Descriptor -State "rolled_back"
}

function Get-IncompleteObservabilityMigrations {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$JournalRoot)

    $journalDirectory = ConvertTo-ObservabilityFullPath -Path $JournalRoot
    if (-not (Test-Path -LiteralPath $journalDirectory -PathType Container)) {
        return @()
    }

    $terminalStates = @("committed", "rolled_back")
    $recovered = @()
    foreach ($journalFile in @(Get-ChildItem -LiteralPath $journalDirectory -File -Filter "migration-*.json" | Sort-Object Name)) {
        $descriptor = Read-ObservabilityMigrationJournal -Path $journalFile.FullName
        if ($descriptor.state -in $terminalStates) {
            continue
        }
        Restore-ObservabilityRuntime -Descriptor $descriptor
        $recovered += $descriptor
    }
    return $recovered
}

Export-ModuleMember -Function @(
    "New-ObservabilityMigrationDescriptor",
    "Write-ObservabilityMigrationJournal",
    "Read-ObservabilityMigrationJournal",
    "Set-ObservabilityMigrationState",
    "Invoke-ObservabilityRuntimePromotion",
    "Restore-ObservabilityRuntime",
    "Get-IncompleteObservabilityMigrations"
)
