# Default: snapshot/check public code archives on the exact stopped worker.
# Apply/Rollback preserve archive mode, uid and gid; never create a new mount.
# No worker start, bot, provider, credential or data operation.
param([switch]$Apply,[switch]$Rollback)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($Apply -and $Rollback){throw 'Choose one code operation'}
$base='C:\Users\adity\.lct-recovery\20261017'
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$w=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $w.Id -ne $worker -or $w.State.Running -or $w.Config.User -ne 'app' -or $w.Name -ne '/lct-meet-first-failure-20261020' -or $w.Image -ne 'sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3'){throw 'Exact stopped holder differs; no code operation'}
$code="exec(__import__('base64').b64decode('aW1wb3J0IG9zLGpzb24sZGphbmdvCmFzc2VydCBvcy5lbnZpcm9uLmdldCgnUE9TVEdSRVNfREInKT09J2xjdF9tZWV0X3JlY292ZXJ5XzIwMjYxMDE3JwpkamFuZ28uc2V0dXAoKQpmcm9tIGRqYW5nby5jb25mIGltcG9ydCBzZXR0aW5ncwpmcm9tIGJvdHMubW9kZWxzIGltcG9ydCBCb3QsQm90U3RhdGVzCmFzc2VydCBzZXR0aW5ncy5EQVRBQkFTRVNbJ2RlZmF1bHQnXVsnTkFNRSddPT0nbGN0X21lZXRfcmVjb3ZlcnlfMjAyNjEwMTcnIGFuZCBzZXR0aW5ncy5EQVRBQkFTRVNbJ2RlZmF1bHQnXVsnSE9TVCddPT0ncG9zdGdyZXMnCmFzc2VydCBCb3Qub2JqZWN0cy5jb3VudCgpPT02IGFuZCBhbGwoYi5wcm9qZWN0Lm5hbWU9PSdMQ1QgaXNvbGF0ZWQgcmVjb3ZlcnknIGFuZCBCb3RTdGF0ZXMuc3RhdGVfdG9fYXBpX2NvZGUoYi5zdGF0ZSkgaW4gKCdlbmRlZCcsJ2ZhdGFsX2Vycm9yJywnZGF0YV9kZWxldGVkJykgZm9yIGIgaW4gQm90Lm9iamVjdHMuYWxsKCkpCnByaW50KGpzb24uZHVtcHMoeydyZXRhaW5lZF90ZXJtaW5hbF9ib3RzJzo2LCdib3Rfc2VudCc6RmFsc2V9KSkK'))"
& docker exec $app python -c $code
if($LASTEXITCODE -ne 0){throw 'Six terminal bot precondition failed'}
$backup=Join-Path $base 'public-presentation-code-archives'
if(!(Test-Path $backup)){New-Item -ItemType Directory -Path $backup|Out-Null}
# Run only the installed Docker client, with literal constrained arguments. Binary
# archive streams use BaseStream, avoiding PowerShell's text-pipeline conversion.
function DockerStream([string]$Arguments,[string]$InputFile,[string]$OutputFile){
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName='docker.exe';$info.Arguments=$Arguments;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $process=New-Object Diagnostics.Process;$process.StartInfo=$info
 if(!$process.Start()){throw 'Owned Docker operation failed to start'}
 $err=$process.StandardError.ReadToEndAsync();$copy=$null;$stream=$null;$text=$null
 try{
  if($OutputFile){$stream=[IO.File]::Open($OutputFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write);$copy=$process.StandardOutput.BaseStream.CopyToAsync($stream)}else{$text=$process.StandardOutput.ReadToEndAsync()}
  if($InputFile){$inputStream=[IO.File]::OpenRead($InputFile);try{$inputStream.CopyTo($process.StandardInput.BaseStream)}finally{$inputStream.Dispose()}}
  $process.StandardInput.Close()
  if(!$process.WaitForExit(30000)){$process.Kill();throw 'Owned Docker command timed out; keep worker stopped and reconcile code'}
  if($copy){$copy.GetAwaiter().GetResult()}
  if($process.ExitCode -ne 0){throw ('Docker code operation failed: '+$err.Result)}
  if($text){return $text.Result}
 }finally{if($stream){$stream.Dispose()};$process.Dispose()}
}
function ArchiveInfo([string]$Path){
 # This public archive is parsed in the already-running app, with no framework
 # import, disk write, credential access or network. Only metadata is returned.
 $python="import sys,tarfile,io,json,hashlib;t=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:');m=t.getmembers();assert len(m)==1 and m[0].isfile() and '/' not in m[0].name and m[0].size<500000;x=m[0];print(json.dumps(dict(name=x.name,mode=x.mode,uid=x.uid,gid=x.gid,sha=hashlib.sha256(t.extractfile(x).read()).hexdigest())))"
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($python))
 $code="exec(__import__('base64').b64decode('"+$encoded+"'))"
 return (DockerStream ('exec -i '+$app+' python -c '+[char]34+$code+[char]34) $Path ''|ConvertFrom-Json)
}
$files=@(
 @{name='payload';basename='google_meet_chromedriver_payload.js';path='/attendee/bots/google_meet_bot_adapter/google_meet_chromedriver_payload.js';directory='/attendee/bots/google_meet_bot_adapter';old='18d1d59242bbe7089b157e008a1cd343aa40b590c29f1cd932b928f9f4934d50';new='533a3da120ab8d34786848aad19482c887ed1dfaf188befce574aac97463b4b5'},
 @{name='audio';basename='per_participant_non_streaming_audio_input_manager.py';path='/attendee/bots/bot_controller/per_participant_non_streaming_audio_input_manager.py';directory='/attendee/bots/bot_controller';old='24156fdfee8f8e0fc67b05605b3e97ea6f8e50dd804a4417bb893156f7981d6c';new='afeecf3ade080dd1728b16dbf04ff5909767ae3150f2bea392689dfd08543a51'}
)
foreach($f in $files){
 foreach($m in $w.Mounts){if(!$m.RW -and ($f.path -eq $m.Destination -or $f.path.StartsWith($m.Destination.TrimEnd('/')+'/'))){throw 'Do not bypass a readonly mount'}}
 $original=Join-Path $backup ($f.name+'.original.tar')
 if(!(Test-Path $original)){
  if($Rollback){throw 'Original archive missing; no action'}
  DockerStream ('cp '+$worker+':'+$f.path+' -') '' $original|Out-Null
 }
 $meta=ArchiveInfo $original
 if($meta.name -ne $f.basename -or $meta.sha -ne $f.old){throw 'Original public source archive differs; preserve it'}
 $current=Join-Path $backup ($f.name+'.current-'+[guid]::NewGuid().ToString('N')+'.tar')
 DockerStream ('cp '+$worker+':'+$f.path+' -') '' $current|Out-Null
 $now=ArchiveInfo $current
 if($now.name -ne $meta.name -or $now.mode -ne $meta.mode -or $now.uid -ne $meta.uid -or $now.gid -ne $meta.gid){throw 'Current code ownership/mode differs; no overwrite'}
 if($Rollback){if($now.sha -notin @($f.old,$f.new)){throw 'Unknown partial source; preserve it'}}elseif($now.sha -ne $f.old){throw 'Current source differs; preserve it'}
 $f.original=$original;$f.metadata=$meta
 if($Apply){
  $replacement=Join-Path $base ($f.name+'.replacement.tar');$next=ArchiveInfo $replacement
  if($next.sha -ne $f.new -or $next.name -ne $meta.name -or $next.mode -ne $meta.mode -or $next.uid -ne $meta.uid -or $next.gid -ne $meta.gid){throw 'Replacement content or original ownership/mode differs'}
  $f.replacement=$replacement
 }
}
# Both files pass before either write. On partial failure, worker stays stopped;
# Rollback accepts a mix of the two known hashes and restores exact old metadata.
if($Apply -or $Rollback){
 foreach($f in $files){
  $source=$f.replacement;$expected=$f.new;if($Rollback){$source=$f.original;$expected=$f.old}
  DockerStream ('cp - '+$worker+':'+$f.directory) $source ''|Out-Null
  $readback=Join-Path $backup ($f.name+'.readback-'+[guid]::NewGuid().ToString('N')+'.tar')
  DockerStream ('cp '+$worker+':'+$f.path+' -') '' $readback|Out-Null
  $actual=ArchiveInfo $readback;$meta=$f.metadata
  if($actual.sha -ne $expected -or $actual.name -ne $meta.name -or $actual.mode -ne $meta.mode -or $actual.uid -ne $meta.uid -or $actual.gid -ne $meta.gid){throw 'Code content/ownership/mode readback differs; do not start worker'}
 }
}
$after=(& docker inspect $worker|ConvertFrom-Json)[0]
if($after.Id -ne $worker -or $after.State.Running){throw 'Worker unexpectedly active'}
@{dry_run=(!$Apply -and !$Rollback);applied=[bool]$Apply;rolled_back=[bool]$Rollback;worker_stopped=$true;public_files=2;ownership_and_mode_preserved=$true;data_retained=$true;bot_sent=$false}|ConvertTo-Json -Compress
