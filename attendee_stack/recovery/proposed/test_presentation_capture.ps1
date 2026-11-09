# Test intent: actual public caption/audio consumers and synthetic wire only.
# Baseline must fail exactly five RMS cases; repaired source must pass all eight.
# No worker, timer, bot, provider or DB mutation. Preserve synthetic evidence.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$base='C:\Users\adity\.lct-recovery\20261017'
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
$code="exec(__import__('base64').b64decode('aW1wb3J0IG9zLGpzb24sZGphbmdvCmFzc2VydCBvcy5lbnZpcm9uLmdldCgnUE9TVEdSRVNfREInKT09J2xjdF9tZWV0X3JlY292ZXJ5XzIwMjYxMDE3JwpkamFuZ28uc2V0dXAoKQpmcm9tIGRqYW5nby5jb25mIGltcG9ydCBzZXR0aW5ncwpmcm9tIGJvdHMubW9kZWxzIGltcG9ydCBCb3QsQm90U3RhdGVzCmFzc2VydCBzZXR0aW5ncy5EQVRBQkFTRVNbJ2RlZmF1bHQnXVsnTkFNRSddPT0nbGN0X21lZXRfcmVjb3ZlcnlfMjAyNjEwMTcnIGFuZCBzZXR0aW5ncy5EQVRBQkFTRVNbJ2RlZmF1bHQnXVsnSE9TVCddPT0ncG9zdGdyZXMnCmFzc2VydCBCb3Qub2JqZWN0cy5jb3VudCgpPT02IGFuZCBhbGwoYi5wcm9qZWN0Lm5hbWU9PSdMQ1QgaXNvbGF0ZWQgcmVjb3ZlcnknIGFuZCBCb3RTdGF0ZXMuc3RhdGVfdG9fYXBpX2NvZGUoYi5zdGF0ZSkgaW4gKCdlbmRlZCcsJ2ZhdGFsX2Vycm9yJywnZGF0YV9kZWxldGVkJykgZm9yIGIgaW4gQm90Lm9iamVjdHMuYWxsKCkpCnByaW50KGpzb24uZHVtcHMoeydyZXRhaW5lZF90ZXJtaW5hbF9ib3RzJzo2LCdib3Rfc2VudCc6RmFsc2V9KSkK'))"
& docker exec $app python -c $code
if($LASTEXITCODE -ne 0){throw 'Six terminal bot precondition failed'}
$root='/tmp/lct-presentation-capture-test'
& docker exec $app python -c "from pathlib import Path;Path('$root').mkdir(exist_ok=False)"
if($LASTEXITCODE -ne 0){throw 'Preserve existing synthetic test root'}
foreach($name in @('test_meet_capture_consumer.py','audio_input_manager_repaired.py','synthetic-presentation-five-seconds.json')){
 & docker cp (Join-Path $base $name) ($app+':'+$root+'/'+$name)
 if($LASTEXITCODE -ne 0){throw ('Synthetic source transfer failed: '+$name)}
}
$original='/attendee/bots/bot_controller/per_participant_non_streaming_audio_input_manager.py'
$check="from pathlib import Path;import hashlib;assert hashlib.sha256(Path('$original').read_bytes()).hexdigest()=='24156fdfee8f8e0fc67b05605b3e97ea6f8e50dd804a4417bb893156f7981d6c';assert hashlib.sha256(Path('$root/audio_input_manager_repaired.py').read_bytes()).hexdigest()=='afeecf3ade080dd1728b16dbf04ff5909767ae3150f2bea392689dfd08543a51'"
& docker exec $app python -c $check
if($LASTEXITCODE -ne 0){throw 'Actual public consumer source differs'}
$caption='/attendee/bots/bot_controller/closed_caption_manager.py'
$ErrorActionPreference='Continue'
$before=@(& docker exec $app python ($root+'/test_meet_capture_consumer.py') $caption $original ($root+'/synthetic-presentation-five-seconds.json') 2>&1|ForEach-Object{[string]$_})
$beforeExit=$LASTEXITCODE
$ErrorActionPreference='Stop'
$beforeText=$before -join [Environment]::NewLine
if($beforeExit -ne 1 -or $beforeText -notmatch 'Ran 8 tests' -or $beforeText -notmatch 'FAILED \(failures=5\)' -or $beforeText -match '(?m)^ERROR:'){throw 'Expected five-case original RMS failure not reproduced'}
$ErrorActionPreference='Continue'
$after=@(& docker exec $app python ($root+'/test_meet_capture_consumer.py') $caption ($root+'/audio_input_manager_repaired.py') ($root+'/synthetic-presentation-five-seconds.json') 2>&1|ForEach-Object{[string]$_})
$afterExit=$LASTEXITCODE
$ErrorActionPreference='Stop'
$afterText=$after -join [Environment]::NewLine
$evidence=Join-Path $base 'private\presentation-capture-synthetic.txt'
if(Test-Path $evidence){throw 'Preserve prior synthetic evidence'}
[IO.File]::WriteAllText($evidence,('BASELINE'+[Environment]::NewLine+$beforeText+[Environment]::NewLine+'REPAIRED'+[Environment]::NewLine+$afterText),[Text.UTF8Encoding]::new($false))
if($afterExit -ne 0 -or $afterText -notmatch 'Ran 8 tests' -or $afterText -notmatch '(?m)^OK\s*$'){throw 'Actual repaired capture consumer tests failed'}
& docker exec $app python -c $code
if($LASTEXITCODE -ne 0){throw 'Terminal bot state changed during synthetic tests'}
@{actual_consumer_tests=8;baseline_expected_failures=5;repaired_passed=8;bot_sent=$false;database_changed=$false}|ConvertTo-Json -Compress
