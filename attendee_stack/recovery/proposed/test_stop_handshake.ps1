# Test intent: execute the production child handshake in isolated owned files,
# ending before Docker stop. Verify valid ack, missing trigger expiry and invalid
# identity/deadline refusal. Prior exact-worker stop is separately instrumented.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$base='C:\Users\adity\.lct-recovery\20261017'
$source=[IO.File]::ReadAllText((Join-Path $base 'stop_diagnostic_worker.ps1'))
$match=[regex]::Match($source,"(?s)\`$child=@'\r?\n(.*?)\r?\n'@")
if(!$match.Success){throw 'Child source not found'}
$prefix=$match.Groups[1].Value.Split(@('$delay=[Math]::Max'),[StringSplitOptions]::None)[0]
if($prefix -match 'docker'){throw 'Synthetic protocol test must end before Docker action'}
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$root=Join-Path $base ('private\synthetic-stop-handshake-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
foreach($window in @(85,285)){
foreach($case in @('valid','missing','wrong-worker','too-long','too-short')){
 $dir=Join-Path $root ([string]$window+'-'+$case);New-Item -ItemType Directory -Path $dir|Out-Null
 $ready=Join-Path $dir 'ready.json';$start=Join-Path $dir 'start.json';$active=Join-Path $dir 'active.json'
 $watch=[DateTime]::UtcNow.AddSeconds(2).ToString('o')
 $child=$prefix.Replace('__WINDOW__',[string]$window).Replace('__MINIMUM__',[string]($window-15)).Replace('__DEADLINE__',$watch).Replace('__READY__',$ready).Replace('__START__',$start).Replace('__ACTIVE__',$active)
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
 $process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'stdout.txt') -RedirectStandardError (Join-Path $dir 'stderr.txt') -PassThru
 $until=[DateTime]::UtcNow.AddSeconds(2)
 while(!(Test-Path $ready) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 25}
 if(!(Test-Path $ready)){throw ('Synthetic readiness missing: '+$case)}
 if($case -ne 'missing'){
  $target=$worker;if($case -eq 'wrong-worker'){$target='wrong-synthetic-holder'}
  $seconds=$window;if($case -eq 'too-long'){$seconds=$window+15};if($case -eq 'too-short'){$seconds=1}
  [IO.File]::WriteAllText($start,(@{worker=$target;deadline=[DateTime]::UtcNow.AddSeconds($seconds).ToString('o')}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 }
 if(!$process.WaitForExit(5000)){throw ('Synthetic protocol did not finish: '+$case)}
 if($case -eq 'valid'){
  if(!(Test-Path $active)){throw 'Valid dispatch was not acknowledged'}
  $a=[IO.File]::ReadAllText($active)|ConvertFrom-Json
  if($a.worker -ne $worker -or !$a.active){throw 'Valid acknowledgement identity differs'}
 }elseif(Test-Path $active){throw ('Invalid dispatch was accepted: '+$case)}
 if($case -notin @('valid','missing') -and [IO.File]::ReadAllText((Join-Path $dir 'stderr.txt')) -notmatch 'Dispatch deadline invalid'){throw 'Expected invalid-dispatch refusal missing'}
 @{window_seconds=$window;case=$case;passed=$true;docker_action=$false;bot_sent=$false}|ConvertTo-Json -Compress
}
}
