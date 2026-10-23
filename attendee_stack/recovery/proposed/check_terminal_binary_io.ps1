# Synthetic byte-integrity fixture only; no recorder, queue or database actions.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
$a=(& docker inspect $app|ConvertFrom-Json)[0]
if($LASTEXITCODE -ne 0 -or $a.Id -ne $app -or !$a.State.Running -or $a.Config.User -ne 'app' -or $a.Image -ne 'sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3'){throw 'Exact fixture runtime differs'}
$base='C:\Users\adity\.lct-recovery\20261017\acceptance-20261022'
$dir=Join-Path $base ('binary-fixture-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir|Out-Null
$inputFile=Join-Path $dir 'input.bin';$outputFile=Join-Path $dir 'output.bin'
[IO.File]::WriteAllBytes($inputFile,[byte[]](@(0..255)*4))
$command='docker exec -i '+$app+' python -c "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())" < "'+$inputFile+'" > "'+$outputFile+'"'
& cmd.exe /d /c $command
if($LASTEXITCODE -ne 0){throw 'Binary echo fixture failed'}
$before=(Get-FileHash $inputFile -Algorithm SHA256).Hash.ToLower()
$after=(Get-FileHash $outputFile -Algorithm SHA256).Hash.ToLower()
if($before -ne $after -or (Get-Item $outputFile).Length -ne 1024){throw 'Binary fixture bytes changed'}
@{binary_bytes=1024;all_256_values_repeated=4;sha256=$after;identical=$true;queue_changed=$false}|ConvertTo-Json -Compress
