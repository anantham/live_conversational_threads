# Test intent: verify exact synthetic baseline refusal and repaired public behavior; preserve results, never start a bot.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$base='C:\Users\adity\.lct-recovery\20261017'
Set-Location (Join-Path $base 'private\stack')
foreach($name in @('first-failure-baseline-exact.txt','first-failure-proposed-exact.txt')){if(Test-Path (Join-Path $base $name)){throw 'Preserve prior synthetic evidence; do not rerun'}}
if((Get-FileHash (Join-Path $base 'google_meet_ui_diagnostic_9c67d6f.py') -Algorithm SHA256).Hash.ToLower() -ne '260172214810776fbe1b32e2d698a18972d9fed5ad62263b2d9dd06d9ec4c7e5'){throw 'Public input hash differs'}
if((Get-FileHash (Join-Path $base 'test_meet_dialog_diagnostics_9c67d6f.py') -Algorithm SHA256).Hash.ToLower() -ne '98836d8e27a07116c38e5d9deac1cd681882ed4162e59f20a88d8807296a6932'){throw 'Public input hash differs'}
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
$a=(& docker inspect $app|ConvertFrom-Json)[0]
if(!$a.State.Running -or $a.Config.User -ne 'app' -or $a.Image -ne 'sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3'){throw 'Runtime identity differs'}
& docker cp (Join-Path $base 'google_meet_ui_diagnostic_9c67d6f.py') ($app+':/tmp/lct_google_meet_ui_diagnostic_9c67d6f.py')
if($LASTEXITCODE -ne 0){throw 'Public derived source copy failed'}
& docker cp (Join-Path $base 'test_meet_dialog_diagnostics_9c67d6f.py') ($app+':/tmp/lct_test_meet_dialog_diagnostics_9c67d6f.py')
if($LASTEXITCODE -ne 0){throw 'Public test copy failed'}
$ErrorActionPreference='Continue'
$old=@(& docker exec $app python /tmp/lct_test_meet_dialog_diagnostics_9c67d6f.py /tmp/lct_google_meet_ui_repaired.py 2>&1|ForEach-Object {[string]$_.ToString()})
$oldCode=$LASTEXITCODE
$ErrorActionPreference='Stop'
$text=$old -join [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $base 'first-failure-baseline-exact.txt'),$text,[Text.UTF8Encoding]::new($false))
if($oldCode -ne 1 -or $text -notmatch 'Ran 9 tests' -or $text -notmatch 'FAILED \(failures=1\)' -or $text -notmatch 'FAIL: test_first_failure_persists_only_one_snapshot' -or $text -match '(?m)^ERROR:'){$text;throw 'Before-test did not reproduce exactly one intended regression; stop'}
@{phase='before';expected_regression_reproduced=$true;summary=@($old|Where-Object {$_ -match '^Ran|^FAILED|^ERROR:|^FAIL:'})}|ConvertTo-Json -Compress
$ErrorActionPreference='Continue'
$new=@(& docker exec $app python /tmp/lct_test_meet_dialog_diagnostics_9c67d6f.py /tmp/lct_google_meet_ui_diagnostic_9c67d6f.py 2>&1|ForEach-Object {[string]$_.ToString()})
$newCode=$LASTEXITCODE
$ErrorActionPreference='Stop'
$newText=$new -join [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $base 'first-failure-proposed-exact.txt'),$newText,[Text.UTF8Encoding]::new($false))
if($newCode -ne 0 -or $newText -notmatch 'Ran 9 tests' -or $newText -notmatch 'OK'){$newText;throw 'Repaired public behavior tests failed; no runtime change'}
@{phase='after';tests=9;passed=$true;runtime_changed=$false;bot_created=$false;provider_called=$false}|ConvertTo-Json -Compress
