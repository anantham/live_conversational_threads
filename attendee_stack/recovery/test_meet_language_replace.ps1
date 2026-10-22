# Intent: tests/intent/meet-language-scope.md. Tiny public files only, in a new
# namespace assigned before loading functions. No Docker, DB, worker or bot.
param([string]$SourceModule=(Join-Path $PSScriptRoot 'proposed\apply_meet_language.ps1'))
$ErrorActionPreference='Stop'
$root=Join-Path 'C:\Users\adity\.lct-recovery\20261017' ('public-language-replace-test-'+[guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $root){throw 'Preserve existing fixture root'}
New-Item -ItemType Directory -Path $root|Out-Null
$module=$SourceModule
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile($module,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source operation syntax invalid'}
$names=@('Hash','BytesHash','WriteVerifiedPublicFile')
$functions=@($tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names},$true))
if($functions.Count -ne 3){throw 'Expected source-operation function surface differs'}
foreach($definition in $functions){. ([ScriptBlock]::Create($definition.Extent.Text))}
$old=[Text.Encoding]::UTF8.GetBytes('synthetic-public-original')
$new=[Text.Encoding]::UTF8.GetBytes('synthetic-public-replacement')
$oldHash=BytesHash $old;$newHash=BytesHash $new
$source=Join-Path $root 'source.py';$backup=Join-Path $root 'original.py'
[IO.File]::WriteAllBytes($source,$old);[IO.File]::WriteAllBytes($backup,$old)
$acl=(Get-Acl -LiteralPath $source).Sddl;$attributes=(Get-Item -LiteralPath $source).Attributes
WriteVerifiedPublicFile $source $new $newHash $oldHash
if((Hash $source) -ne $newHash -or (Hash $backup) -ne $oldHash -or (Get-Acl -LiteralPath $source).Sddl -ne $acl -or (Get-Item -LiteralPath $source).Attributes -ne $attributes){throw 'Replacement/backup/metadata behavior failed'}
WriteVerifiedPublicFile $source $old $oldHash $newHash
if((Hash $source) -ne $oldHash -or (Hash $backup) -ne $oldHash){throw 'Restore behavior failed'}
$interrupted=$false
try{WriteVerifiedPublicFile $source $new $newHash $oldHash {param($stream,$content) $stream.Write($content,0,4);$stream.Flush($true);throw 'Synthetic interrupted write'}}catch{$interrupted=$true}
if(!$interrupted -or (Hash $source) -ne $oldHash -or (Hash $backup) -ne $oldHash -or (Get-Acl -LiteralPath $source).Sddl -ne $acl -or (Get-Item -LiteralPath $source).Attributes -ne $attributes){throw 'Interrupted write did not restore exact original bytes/permissions/attributes'}
foreach($case in @('wrong-source','wrong-replacement','read-only')){
    $expected=$newHash;$prior=$oldHash
    if($case -eq 'wrong-source'){$prior=$newHash}
    if($case -eq 'wrong-replacement'){$expected=$oldHash}
    if($case -eq 'read-only'){[IO.File]::SetAttributes($source,($attributes -bor [IO.FileAttributes]::ReadOnly))}
    $refused=$false
    try{WriteVerifiedPublicFile $source $new $expected $prior}catch{$refused=$true}
    if(!$refused -or (Hash $source) -ne $oldHash -or (Hash $backup) -ne $oldHash){throw ('Refusal did not preserve files: '+$case)}
}
@{synthetic_checks=6;passed=$true;fixture_files_retained=$true;runtime_changed=$false;worker_started=$false;bot_created=$false}|ConvertTo-Json -Compress
