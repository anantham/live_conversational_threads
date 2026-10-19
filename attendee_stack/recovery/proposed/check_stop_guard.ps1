# Test intent: real default read-only readiness and wrong-target refusal;
# never pass -Arm, launch a supervisor, stop a container or create a bot.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$path='C:\Users\adity\.lct-recovery\20261017\stop_diagnostic_worker.ps1'
$tokens=$null;$errors=$null
[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)|Out-Null
if($errors.Count -ne 0){throw 'Stop guard PowerShell syntax invalid'}
& $path
$source=[IO.File]::ReadAllText($path)
$wrong=$source.Replace('692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a','8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd')
$refused=$false
try{& ([scriptblock]::Create($wrong))}catch{if($_.Exception.Message -match 'Dedicated worker identity differs'){$refused=$true}else{throw}}
if(!$refused){throw 'Wrong-target guard did not refuse'}
foreach($id in @('692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a','8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd')){
 $a=(& docker inspect $id|ConvertFrom-Json)[0]
 if($LASTEXITCODE -ne 0 -or $a.Id -ne $id -or !$a.State.Running){throw 'Validation changed running holder'}
}
if(Test-Path 'C:\Users\adity\.lct-recovery\20261017\private\first-failure-stop-692a6837'){throw 'Validation unexpectedly armed a supervisor'}
$runner='C:\Users\adity\.lct-recovery\20261017\run_diagnostic_once.ps1'
[System.Management.Automation.Language.Parser]::ParseFile($runner,[ref]$tokens,[ref]$errors)|Out-Null
if($errors.Count -ne 0){throw 'Diagnostic wrapper syntax invalid'}
& $runner -RecordingId '00000000-0000-4000-8000-000000000004' -MeetingUrl 'https://meet.google.com/abc-defg-hij'
foreach($mode in @('CheckGuard','Create')){
 $refused=$false
 try{if($mode -eq 'CheckGuard'){& $runner -CheckGuard}else{& $runner -RecordingId '00000000-0000-4000-8000-000000000004' -MeetingUrl 'https://meet.google.com/abc-defg-hij' -Create}}
 catch{if($_.Exception.Message -match 'Independent stop guard not active'){$refused=$true}else{throw}}
 if(!$refused){throw 'Missing-guard path did not refuse'}
}
@{missing_guard_refused=$true;serializer_dry_run=$true;syntax_valid=$true;correct_target_ready=$true;wrong_target_refused=$true;both_holders_running=$true;supervisor_armed=$false;bot_sent=$false}|ConvertTo-Json -Compress
