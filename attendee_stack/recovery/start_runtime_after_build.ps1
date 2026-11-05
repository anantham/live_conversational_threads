<#
Non-recording continuation for this isolated recovery only. No worker or public route.
Waits for the one bounded build, then validates/imports/migrates/bootstrap/checks API/S3.
Every native command must succeed; preserves new/old data and credential bytes.
#>
param([ValidateSet('cached-pip','verified-wheels','direct-wheels')][string]$BuildMethod='cached-pip')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$b='C:\Users\adity\.lct-recovery\20261017'
$runtime=Join-Path $b 'private\stack'
$prefix=if($BuildMethod -eq 'cached-pip'){'runtime-ready'}else{'runtime-'+$BuildMethod}
$acceptancePrefix=if($BuildMethod -eq 'cached-pip'){'runtime-acceptance'}else{$prefix+'-acceptance'}
$buildExit=Join-Path $b ('build-'+$BuildMethod+'-exit.txt')
$log=Join-Path $b ($prefix+'-setup.log')
$code=97
$appStarted=$false
# A duplicate must preserve the completed receipt byte-for-byte.
if(Test-Path "$b\$prefix-exit.txt"){exit 97}
try {
 $deadline=(Get-Date).AddHours(2)
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'waiting for bounded image build')
 while(!(Test-Path "$buildExit") -and (Get-Date) -lt $deadline){Start-Sleep -Seconds 10}
 if(!(Test-Path "$buildExit") -or (Get-Content "$buildExit" -Raw).Trim() -ne '0'){throw 'Image prerequisite failed or expired; app/worker stay off'}
 $image=(& docker image inspect 'lct-attendee:recovery-500168b1'|ConvertFrom-Json)[0]
 if($LASTEXITCODE -ne 0 -or $image.Config.User -ne 'app' -or $image.Architecture -ne 'amd64' -or $image.Os -ne 'linux'){throw 'Unexpected final app image identity/user'}
 if((Get-FileHash (Join-Path $runtime 'compose.json') -Algorithm SHA256).Hash -ne '80DB4A7E37C2FDB9722A66576AD36DBE66591B4BDCF46824148E3960E297E66B'){throw 'Reviewed Compose identity drift'}
 if((Get-FileHash (Join-Path $b 'check_runtime.py') -Algorithm SHA256).Hash -ne '3A26B62ED2129178953DEBD3D84EF76AA7FFC65364E7D6116A381E7AD991CDE6'){throw 'Reviewed readiness source identity drift'}
 $secretHash=(Get-FileHash (Join-Path $runtime 'runtime.env') -Algorithm SHA256).Hash
 Set-Location $runtime
 $app=& docker ps -aq --filter 'label=com.docker.compose.project=lct-meet-recovery-20261017' --filter 'label=com.docker.compose.service=app'
 if($LASTEXITCODE -ne 0 -or $app){throw 'Refuse an existing app holder'}
 $worker=& docker ps -aq --filter 'label=com.docker.compose.project=lct-meet-recovery-20261017' --filter 'label=com.docker.compose.service=worker'
 if($LASTEXITCODE -ne 0 -or $worker){throw 'Refuse an existing worker holder'}
 if(Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue){throw 'Preserve existing listener on8088'}
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'actual app imports and URL configuration')
 & cmd.exe /d /s /c ('docker compose --env-file runtime.env -f compose.json run --rm --no-deps app python manage.py check > "'+$log+'" 2>&1')
 if($LASTEXITCODE -ne 0){throw 'Django import/configuration check failed'}
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'dedicated database migrations')
 & cmd.exe /d /s /c ('docker compose --env-file runtime.env -f compose.json run --rm --no-deps app python manage.py migrate --noinput >> "'+$log+'" 2>&1')
 if($LASTEXITCODE -ne 0){throw 'Dedicated database migration failed'}
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'guarded project/key/private-bucket bootstrap')
 & cmd.exe /d /s /c ('docker compose --env-file runtime.env -f compose.json run --rm --no-deps app python /recovery/bootstrap.py >> "'+$log+'" 2>&1')
 if($LASTEXITCODE -ne 0){throw 'Guarded recovery bootstrap failed'}
 $appStarted=$true
 & cmd.exe /d /s /c ('docker compose --env-file runtime.env -f compose.json up -d --no-deps app >> "'+$log+'" 2>&1')
 if($LASTEXITCODE -ne 0){throw 'Loopback API start failed'}
 $app=@(& docker compose --env-file runtime.env -f compose.json ps -q app)
 if($LASTEXITCODE -ne 0 -or $app.Count -ne 1 -or !$app[0]){throw 'No single isolated app container after startup'}
 $app=[string]$app[0]
 $actual=(& docker inspect $app|ConvertFrom-Json)[0]
 if($LASTEXITCODE -ne 0 -or $actual.Image -ne $image.Id -or $actual.Config.Labels.'com.docker.compose.project' -ne 'lct-meet-recovery-20261017'){throw 'Actual app runtime differs from expected image/project'}
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'waiting for loopback API authentication refusal')
 $deadline=(Get-Date).AddSeconds(90);$status=0
 while((Get-Date) -lt $deadline){
  try {$response=Invoke-WebRequest -Uri 'http://127.0.0.1:8088/api/v1/bots' -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0;$status=[int]$response.StatusCode}
  catch {if($_.Exception.Response){$status=[int]$_.Exception.Response.StatusCode}else{$status=0}}
  if($status -eq 401){break};if($status -ge 200 -and $status -lt 400){throw 'Unauthenticated API unexpectedly allowed; do not expose'};Start-Sleep -Seconds 3
 }
 if($status -ne 401){throw 'Loopback API did not become ready within90seconds'}
 & docker cp (Join-Path $b 'check_runtime.py') ($app+':/tmp/lct-check-runtime.py')
 if($LASTEXITCODE -ne 0){throw 'Public readiness source staging failed'}
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'real schema, private API and S3 acceptance')
 & cmd.exe /d /s /c ('docker compose --env-file runtime.env -f compose.json exec -T app python /tmp/lct-check-runtime.py > "'+$b+'\'+$acceptancePrefix+'.json" 2> "'+$b+'\'+$acceptancePrefix+'.stderr.txt"')
 if($LASTEXITCODE -ne 0){throw 'Actual schema/API/S3 acceptance failed; no worker or bot started'}
 if((Get-FileHash (Join-Path $runtime 'runtime.env') -Algorithm SHA256).Hash -ne $secretHash){throw 'Credential contents changed'}
 [IO.File]::WriteAllText("$b\$prefix-result.json",(@{image_id=$image.Id;app_id=$app;credential_bytes_preserved=$true;non_recording_acceptance=$true;worker_started=$false;public_ingress_changed=$false}|ConvertTo-Json -Compress))
 [IO.File]::WriteAllText("$b\$prefix-phase.txt",'non-recording acceptance passed; worker and public relay remain off')
 $code=0
} catch {
 [IO.File]::WriteAllText("$b\$prefix-error.txt",$_.Exception.GetType().Name+': '+$_.Exception.Message)
 if($appStarted){
  & cmd.exe /d /s /c ('docker compose --env-file runtime.env -f compose.json stop app >> "'+$log+'" 2>&1') | Out-Null
  if($LASTEXITCODE -ne 0){[IO.File]::AppendAllText("$b\$prefix-error.txt",'; failed to stop rejected loopback app; inspect holder')}
 }
}
finally {[IO.File]::WriteAllText("$b\$prefix-exit.txt",[string]$code)}
exit $code
