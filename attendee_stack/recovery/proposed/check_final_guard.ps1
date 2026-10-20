# Test intent: actual stopped-holder refusal in both modes, five terminal bot
# readiness with positive setup events, and ten isolated handshake cases. No bot.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$base='C:\Users\adity\.lct-recovery\20261017'
foreach($name in @('stop_diagnostic_worker.ps1','run_diagnostic_once.ps1','test_stop_handshake.ps1','check_final_guard.ps1')){
 $tokens=$null;$errors=$null
 [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $base $name),[ref]$tokens,[ref]$errors)|Out-Null
 if($errors.Count -ne 0){throw ('PowerShell syntax invalid: '+$name)}
}
foreach($mode in @($false,$true)){
 $refused=$false
 try{& (Join-Path $base 'stop_diagnostic_worker.ps1') -Verification:$mode}catch{if($_.Exception.Message -match 'Dedicated worker identity differs'){$refused=$true}else{throw}}
 if(!$refused){throw 'Stopped holder did not refuse activation'}
}
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
& docker cp (Join-Path $base 'verify_acceptance_ready.py') ($app+':/tmp/lct_verify_acceptance_ready.py')
if($LASTEXITCODE -ne 0){throw 'Public readiness source copy failed'}
& docker exec $app python /tmp/lct_verify_acceptance_ready.py
if($LASTEXITCODE -ne 0){throw 'Actual final pilot preconditions failed'}
& (Join-Path $base 'test_stop_handshake.ps1')
if(Test-Path (Join-Path $base 'private\final-verification-stop-692a6837-v1')){throw 'Real final guard unexpectedly exists'}
@{syntax_valid=$true;stopped_holder_refused=$true;real_guard_armed=$false;bot_sent=$false}|ConvertTo-Json -Compress
