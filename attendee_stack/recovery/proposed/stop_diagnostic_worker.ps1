# Test intent: dry-run checks exact dedicated worker; -Arm creates one bounded
# same-user supervisor. Only that container can be stopped; data/logs remain.
param([switch]$Arm)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$expectedName='/lct-meet-first-failure-20261020'
$base='C:\Users\adity\.lct-recovery\20261017\private'
$guard=Join-Path $base 'first-failure-stop-692a6837'
$a=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $a.Id -ne $worker -or $a.Name -ne $expectedName -or !$a.State.Running -or $a.Config.User -ne 'app' -or $a.Image -ne 'sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3' -or $a.Config.Labels.'com.docker.compose.project' -ne 'lct-meet-recovery-20261017' -or $a.Config.Labels.'com.docker.compose.service' -ne 'worker'){throw 'Dedicated worker identity differs; no action'}
if(!$Arm){@{dry_run=$true;worker=$worker;stop_after_seconds=80;stop_grace_seconds=2;bot_sent=$false}|ConvertTo-Json -Compress;exit}
if(Test-Path $guard){throw 'Preserve existing one-shot guard; no rearm'}
New-Item -ItemType Directory -Path $guard|Out-Null
$deadline=[DateTime]::UtcNow.AddSeconds(80).ToString('o')
$ready=Join-Path $guard 'ready.json'
$done=Join-Path $guard 'done.json'
$child=@'
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$expectedName='/lct-meet-first-failure-20261020'
$deadline=[DateTime]::Parse('__DEADLINE__').ToUniversalTime()
[IO.File]::WriteAllText('__READY__',(@{worker=$worker;deadline=$deadline.ToString('o');armed=$true}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$delay=[Math]::Max(0,($deadline-[DateTime]::UtcNow).TotalMilliseconds)
Start-Sleep -Milliseconds ([int]$delay)
$a=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $a.Id -ne $worker -or $a.Name -ne $expectedName -or $a.Config.User -ne 'app' -or $a.Image -ne 'sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3' -or $a.Config.Labels.'com.docker.compose.project' -ne 'lct-meet-recovery-20261017' -or $a.Config.Labels.'com.docker.compose.service' -ne 'worker'){throw 'Worker identity changed; no other process touched'}
if($a.State.Running){& docker stop --time 2 $worker|Out-Null;if($LASTEXITCODE -ne 0){throw 'Exact worker stop failed'}}
$after=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $after.Id -ne $worker -or $after.State.Running){throw 'Worker stop not confirmed'}
[IO.File]::WriteAllText('__DONE__',(@{worker=$worker;stopped=$true;finished_at=[DateTime]::UtcNow.ToString('o');data_and_logs_retained=$true}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
'@
$child=$child.Replace('__DEADLINE__',$deadline).Replace('__READY__',$ready).Replace('__DONE__',$done)
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
$process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $guard 'stdout.txt') -RedirectStandardError (Join-Path $guard 'stderr.txt') -PassThru
$hash=[Security.Cryptography.SHA256]::Create()
$commandHash=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($encoded)))).Replace('-','').ToLower()
[IO.File]::WriteAllText((Join-Path $guard 'supervisor.json'),(@{pid=$process.Id;worker=$worker;command_sha256=$commandHash;deadline=$deadline}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$until=[DateTime]::UtcNow.AddSeconds(8)
while(!(Test-Path $ready) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 100}
if(!(Test-Path $ready)){throw 'Stop guard readiness missing; do not send bot'}
$r=[IO.File]::ReadAllText($ready)|ConvertFrom-Json
if($r.worker -ne $worker -or !$r.armed -or $r.deadline -ne $deadline -or [DateTime]::Parse($deadline).ToUniversalTime() -lt [DateTime]::UtcNow.AddSeconds(60)){throw 'Stop guard not ready for bounded bot'}
@{armed=$true;worker=$worker;stop_at=$deadline;supervisor_pid=$process.Id;data_and_logs_retained=$true;bot_sent=$false}|ConvertTo-Json -Compress

# Keep the owning SSH command alive until the exact stop completes. The browser
# path independently verifies supervisor PID/command identity before creating.
if(!$process.WaitForExit(95000)){throw 'Stop supervisor exceeded its bound; reconcile exact worker'}
if($process.ExitCode -ne 0 -or !(Test-Path $done)){throw 'Stop supervisor did not confirm completion; reconcile exact worker'}
[IO.File]::ReadAllText($done)
