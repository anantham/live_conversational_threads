# Test intent: validation is default; -Create additionally requires the actual
# one-shot stop guard ready with >=30seconds left. No credential leaves the app.
param([string]$RecordingId,[string]$MeetingUrl,[int]$Seconds=90,[switch]$Create,[switch]$CheckGuard,[switch]$Begin,[switch]$Verification)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if(!$CheckGuard -and !$Begin -and ($RecordingId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $MeetingUrl -notmatch '^https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$' -or $Seconds -lt 60 -or $Seconds -gt 90)){throw 'Invalid bounded diagnostic arguments'}
if($Verification -and ($Create -or (!$CheckGuard -and !$Begin))){throw 'Verification mode only acknowledges the timer; use ordinary cloud UI for creation'}
$window=85;$guardName='first-failure-stop-692a6837-v3'
if($Verification){$window=285;$guardName='final-verification-stop-692a6837-v1'}
$base='C:\Users\adity\.lct-recovery\20261017'
$source=Join-Path $base 'create_diagnostic_once.py'
if((Get-FileHash $source -Algorithm SHA256).Hash.ToLower() -ne 'e5b1202a6a2deb6820a1db931f9c49aa483ade142192dee227425eb7146db993'){throw 'Reviewed client source differs'}
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$w=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $w.Id -ne $worker -or !$w.State.Running -or $w.Name -ne '/lct-meet-first-failure-20261020'){throw 'Dedicated worker unavailable; no POST'}
if($Create -or $CheckGuard -or $Begin){
 $guard=Join-Path (Join-Path $base 'private') $guardName
 if(!(Test-Path (Join-Path $guard 'ready.json')) -or (Test-Path (Join-Path $guard 'done.json'))){throw 'Independent stop guard not active; no POST'}
 $ready=[IO.File]::ReadAllText((Join-Path $guard 'ready.json'))|ConvertFrom-Json
 $minimum=30;if($CheckGuard -or $Begin){$minimum=60}
 if($ready.worker -ne $worker -or !$ready.armed -or [DateTime]::Parse($ready.deadline).ToUniversalTime() -lt [DateTime]::UtcNow.AddSeconds($minimum)){throw 'Insufficient stop-guard time; no POST'}
 $identity=[IO.File]::ReadAllText((Join-Path $guard 'supervisor.json'))|ConvertFrom-Json
 if($identity.worker -ne $worker -or $identity.deadline -ne $ready.deadline -or $identity.pid -isnot [int] -or $identity.pid -le 0){throw 'Stop supervisor identity invalid; no POST'}
 $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$identity.pid)
 if(!$process -or $process.Name -ne 'powershell.exe' -or $process.CommandLine -notmatch '-EncodedCommand\s+([A-Za-z0-9+/=]+)'){throw 'Stop supervisor process missing; no POST'}
 $encoded=$Matches[1]
 $hash=[Security.Cryptography.SHA256]::Create()
 $actual=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($encoded)))).Replace('-','').ToLower()
 if($actual -ne $identity.command_sha256){throw 'Stop supervisor command identity differs; no POST'}
 if($Begin){
  if((Test-Path (Join-Path $guard 'start.json')) -or (Test-Path (Join-Path $guard 'active.json'))){throw 'Dispatch already begun; no second window'}
  $dispatch=[DateTime]::UtcNow.AddSeconds($window).ToString('o')
  [IO.File]::WriteAllText((Join-Path $guard 'start.json'),(@{worker=$worker;deadline=$dispatch}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $until=[DateTime]::UtcNow.AddSeconds(2)
  while(!(Test-Path (Join-Path $guard 'active.json')) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 50}
  if(!(Test-Path (Join-Path $guard 'active.json'))){throw 'Dispatch timer acknowledgement missing; do not send bot'}
  $active=[IO.File]::ReadAllText((Join-Path $guard 'active.json'))|ConvertFrom-Json
  if($active.worker -ne $worker -or !$active.active -or $active.deadline -ne $dispatch){throw 'Dispatch timer acknowledgement differs; no bot'}
  @{dispatch_ready=$true;stop_at=$dispatch;bot_sent=$false}|ConvertTo-Json -Compress;exit
 }
 if($Create){
  if(!(Test-Path (Join-Path $guard 'active.json'))){throw 'Bot dispatch clock has not begun; no POST'}
  $active=[IO.File]::ReadAllText((Join-Path $guard 'active.json'))|ConvertFrom-Json
  if($active.worker -ne $worker -or !$active.active -or [DateTime]::Parse($active.deadline).ToUniversalTime() -lt [DateTime]::UtcNow.AddSeconds(30)){throw 'Insufficient dispatch time; no POST'}
 }
 if($CheckGuard){@{supervisor_alive=$true;exact_command=$true;stop_at=$ready.deadline;seconds_left=[Math]::Floor(([DateTime]::Parse($ready.deadline).ToUniversalTime()-[DateTime]::UtcNow).TotalSeconds);bot_sent=$false}|ConvertTo-Json -Compress;exit}

}
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
& docker cp $source ($app+':/tmp/lct_create_diagnostic_once.py')
if($LASTEXITCODE -ne 0){throw 'Public diagnostic source copy failed'}
$clientArgs=@('--recording-id',$RecordingId,'--meeting-url',$MeetingUrl,'--seconds',[string]$Seconds)
if($Create){$clientArgs+=@('--create')}
& docker exec $app python /tmp/lct_create_diagnostic_once.py @clientArgs
if($LASTEXITCODE -ne 0){throw 'Diagnostic result uncertain/refused; reconcile original ID, no retry POST'}
