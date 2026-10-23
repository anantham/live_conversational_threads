# Test intent: dry-run by default; modify one pinned public code file only while
# exact worker is stopped. Never start a worker, mutate queues or touch records.
param([switch]$Apply,[switch]$Rollback)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($Apply -and $Rollback){throw 'Choose one source operation'}
$base='C:\Users\adity\.lct-recovery\20261017\acceptance-20261022'
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
$image='sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3'
$target='/attendee/bots/tasks/run_bot_task.py'
$original=Join-Path $base 'run_bot_task.original.tar'
$candidate=Join-Path $base 'run_bot_task.guarded_v2.tar'
$inspector=Join-Path $base 'inspect_terminal_task_archive_v2.py'
foreach($pair in @(@($original,'005e9d70e8055755a860d169a39f61783d740efe29afd8e7b2ccb0166ee3110a'),@($candidate,'0254a85e87df6fde3d28f6fb1ac8f8ea968d02e466b6395502202fdaa3f75e81'),@($inspector,'66b036b660e835b3260e6bab15690b16259612c0d959637a6a9824311bd15306'))){
 if(!(Test-Path -LiteralPath $pair[0]) -or ((Get-Item -LiteralPath $pair[0]).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLower() -ne $pair[1]){throw 'Public deployment input differs'}
}
$w=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $w.Id -ne $worker -or $w.State.Running -or $w.Config.User -ne 'app' -or $w.Image -ne $image -or $w.Name -ne '/lct-meet-first-failure-20261020' -or $w.Config.Labels.'com.docker.compose.project' -ne 'lct-meet-recovery-20261017' -or $w.Config.Labels.'com.docker.compose.service' -ne 'worker'){throw 'Exact stopped worker differs'}
foreach($mount in $w.Mounts){$dest=$mount.Destination.TrimEnd('/');if($target -eq $dest -or $target.StartsWith($dest+'/')){throw 'Task source unexpectedly mounted; no write'}}
$a=(& docker inspect $app|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $a.Id -ne $app -or !$a.State.Running -or $a.Image -ne $image -or $a.Config.User -ne 'app'){throw 'Exact read-only inspection runtime unavailable'}
$root=Join-Path $base 'terminal-task-source-receipts'
if(!(Test-Path $root)){New-Item -ItemType Directory -Path $root|Out-Null}
if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Receipt root is a reparse point'}
$receipt=Join-Path $root ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $receipt|Out-Null
& docker cp $inspector ($app+':/tmp/lct_inspect_terminal_task_archive.py')
if($LASTEXITCODE -ne 0){throw 'Public inspector staging failed'}
function Inspect-Archive([string]$path,[string]$expect){
 $command='docker exec -i '+$app+' python /tmp/lct_inspect_terminal_task_archive.py --expect '+$expect+' < "'+$path+'"'
 $result=& cmd.exe /d /c $command
 if($LASTEXITCODE -ne 0){throw 'Source archive refused; worker remains stopped'}
 return ($result|ConvertFrom-Json)
}
function Export-Current([string]$path){
 & cmd.exe /d /c ('docker cp '+$worker+':'+$target+' - > "'+$path+'"')
 if($LASTEXITCODE -ne 0){throw 'Public source export failed'}
}
$old=Inspect-Archive $original 'original';$new=Inspect-Archive $candidate 'candidate'
$beforePath=Join-Path $receipt 'before.tar';Export-Current $beforePath
$before=Inspect-Archive $beforePath 'either'
if(!$Apply -and !$Rollback){@{dry_run=$true;current_kind=$before.kind;source_sha256=$before.sha256;metadata_preserved=$true;worker_stopped=$true;queue_mutated=$false}|ConvertTo-Json -Compress;exit}
$wanted='candidate';$archive=$candidate
if($Rollback){$wanted='original';$archive=$original}
if($before.kind -eq $wanted){@{unchanged=$true;source_kind=$wanted;worker_stopped=$true}|ConvertTo-Json -Compress;exit}
# No crash-atomicity claim: all archives survive; unknown output stays stopped.
& cmd.exe /d /c ('docker cp -a - '+$worker+':/attendee/bots/tasks/ < "'+$archive+'"')
if($LASTEXITCODE -ne 0){throw 'Source copy uncertain; preserve archives, do not start worker'}
$afterPath=Join-Path $receipt 'after.tar';Export-Current $afterPath
$after=Inspect-Archive $afterPath $wanted
$actual=(& docker inspect $worker|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $actual.Id -ne $worker -or $actual.State.Running){throw 'Stopped-state confirmation failed; no activation'}
@{applied=[bool]$Apply;rolled_back=[bool]$Rollback;source_kind=$after.kind;source_sha256=$after.sha256;uid=$after.uid;gid=$after.gid;mode=$after.mode;worker_stopped=$true;queue_mutated=$false;data_retained=$true}|ConvertTo-Json -Compress
