<#
Approved one-time diagnostic, 18 October 2026.
Test intent: refuse changed image/public wheels or existing receipts; validate
Python/pip/platform before one offline wheel-compatibility check. No dependency
installation, credentials, service start, bot or runtime-data mount.
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$b='C:\Users\adity\.lct-recovery\20261017'
$prefix='wheel-compatibility-20261018'
$directory=Join-Path $b ('public-'+$prefix)
$wheels=Join-Path $b 'public-verified-wheels-host-ready'
$image='sha256:63af3508aa7afdf1c602db1016d7843edc7af084b6b5d6008fa9ee01fba9aa84'
$alias='lct-attendee-base:wheel-check-20261017'
$code=97
if((Test-Path "$b\$prefix-exit.txt") -or (Test-Path $directory)){exit 97}
try {
 $actual=(& docker image inspect $alias|ConvertFrom-Json)[0]
 if($LASTEXITCODE -ne 0 -or $actual.Id -ne $image -or $actual.Os -ne 'linux' -or $actual.Architecture -ne 'amd64'){throw 'Expected upstream Python3/pip base unavailable; do not replace it'}
 $expected=@(
  @{name='opencv_python-4.10.0.84-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl';bytes=62548253;sha='9ACE140FC6D647FBE1C692BCB2ABCE768973491222C067C131D80957C595B71F'},
  @{name='zoom_meeting_sdk-0.0.27-cp310-cp310-manylinux_2_28_x86_64.whl';bytes=118529789;sha='611441CA6DAC8C6BC77384B025645AF23BE1D381A539B1EA6BCD843832C0D6F8'}
 )
 $folder=Get-Item $wheels
 if(!$folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Real public wheel directory required'}
 $entries=@(Get-ChildItem $wheels -Force)
 if($entries.Count -ne 2){throw 'Unexpected wheel context entries'}
 foreach($entry in $entries){
  $match=@($expected|Where-Object{$_.name -ceq $entry.Name})
  if($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $match.Count -ne 1){throw 'Unexpected or linked wheel entry'}
  if($entry.Length -ne $match[0].bytes -or (Get-FileHash $entry.FullName -Algorithm SHA256).Hash -ne $match[0].sha){throw 'Public wheel integrity changed'}
 }
 New-Item -ItemType Directory $directory|Out-Null
 $recipe=Join-Path $directory 'Dockerfile'
 $text=@"
FROM $alias
USER 0:0
RUN --mount=type=bind,from=lct_verified_wheels,target=/lct-wheels,readonly python3 -c "import sys,platform; assert sys.version_info[:2] == (3,10); assert platform.machine() == 'x86_64'; print(sys.version); print(platform.machine())" && python3 -m pip --version && python3 -m pip download --disable-pip-version-check --no-index --no-deps --find-links=/lct-wheels --dest=/tmp/verified-wheel-check opencv-python==4.10.0.84 zoom-meeting-sdk==0.0.27
"@
 [IO.File]::WriteAllText($recipe,$text,[Text.UTF8Encoding]::new($false))
 & cmd.exe /d /s /c ('docker build --pull=false --network=none --progress=plain --build-context "lct_verified_wheels='+$wheels+'" -f "'+$recipe+'" "'+$directory+'" > "'+$b+'\'+$prefix+'.log" 2>&1')
 if($LASTEXITCODE -isnot [int]){throw 'No integer Docker exit status'}
 $code=$LASTEXITCODE
 if($code -ne 0){throw 'Offline prerequisite/compatibility diagnostic failed; do not retry'}
 [IO.File]::WriteAllText("$b\$prefix-result.json",(@{image_id=$image;python='CPython3.10';platform='linux-amd64';verified_wheels=2;offline_compatibility=$true;dependency_installation=$false;worker_started=$false;public_ingress_changed=$false}|ConvertTo-Json -Compress))
} catch {
 [IO.File]::WriteAllText("$b\$prefix-error.txt",$_.Exception.GetType().Name+': '+$_.Exception.Message)
 if($code -eq 0){$code=97}
}
finally {[IO.File]::WriteAllText("$b\$prefix-exit.txt",[string]$code)}
exit $code
