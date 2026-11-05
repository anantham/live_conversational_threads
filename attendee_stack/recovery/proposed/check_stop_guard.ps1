# Test intent: syntax plus actual stopped-holder refusal, unchanged serializer
# readiness on exactly four terminal bots, and isolated five-case timer handshake.
# Never arm a timer, restart a worker, stop a service or create a bot.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$base='C:\Users\adity\.lct-recovery\20261017'
foreach($name in @('stop_diagnostic_worker.ps1','run_diagnostic_once.ps1','test_stop_handshake.ps1')){
 $tokens=$null;$errors=$null
 [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $base $name),[ref]$tokens,[ref]$errors)|Out-Null
 if($errors.Count -ne 0){throw ('PowerShell syntax invalid: '+$name)}
}
$refused=$false
try{& (Join-Path $base 'stop_diagnostic_worker.ps1')}catch{if($_.Exception.Message -match 'Dedicated worker identity differs'){$refused=$true}else{throw}}
if(!$refused){throw 'Stopped holder did not refuse activation'}
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
& docker cp (Join-Path $base 'create_diagnostic_once.py') ($app+':/tmp/lct_create_diagnostic_once.py')
if($LASTEXITCODE -ne 0){throw 'Public serializer probe copy failed'}
& docker exec $app python /tmp/lct_create_diagnostic_once.py --recording-id '00000000-0000-4000-8000-000000000005' --meeting-url 'https://meet.google.com/abc-defg-hij'
if($LASTEXITCODE -ne 0){throw 'Four-terminal-bot serializer precondition failed'}
& docker exec $app python /tmp/lct_create_diagnostic_once.py --recording-id '00000000-0000-4000-8000-000000000005' --meeting-url 'https://meet.google.com/abc-defg-hij' --probe
if($LASTEXITCODE -ne 0){throw 'Existing internal API readiness failed'}
& (Join-Path $base 'test_stop_handshake.ps1')
if(Test-Path (Join-Path $base 'private\first-failure-stop-692a6837-v3')){throw 'Unexpected real v2 guard exists'}
@{syntax_valid=$true;stopped_holder_refused=$true;serializer_dry_run=$true;real_supervisor_armed=$false;bot_sent=$false}|ConvertTo-Json -Compress
