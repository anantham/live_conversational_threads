<# One bounded full build after actual offline compatibility. Test intent: refuse
old receipts/image, diagnostic or source/hash drift; retain unchanged dependencies.
Never start runtime services, a worker, public ingress or a meeting. #>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$b='C:\Users\adity\.lct-recovery\20261017'
$source='C:\Users\adity\Documents\Ongoing Local\attendee-lct-recovery-20261017'
$recipe=Join-Path $b 'public-direct-wheels-build\Dockerfile'
$wheels=Join-Path $b 'public-verified-wheels-host-ready'
$code=97
foreach($suffix in @('-exit.txt','.log','-error.txt')){
 if(Test-Path ("$b\build-direct-wheels"+$suffix)){exit 97}
}
try {
 if((Get-Content "$b\wheel-compatibility-20261018-exit.txt" -Raw).Trim() -ne '0'){throw 'Actual approved offline compatibility missing'}
 $compatibility=Get-Content "$b\wheel-compatibility-20261018-result.json" -Raw|ConvertFrom-Json
 if($compatibility.offline_compatibility -ne $true -or $compatibility.verified_wheels -ne 2 -or $compatibility.image_id -ne 'sha256:63af3508aa7afdf1c602db1016d7843edc7af084b6b5d6008fa9ee01fba9aa84'){throw 'Unexpected diagnostic acceptance'}
 $existing=& docker image ls --filter 'reference=lct-attendee:recovery-500168b1' --format '{{.ID}}'
 if($LASTEXITCODE -ne 0 -or $existing){throw 'Refuse preexisting final image tag'}
 $receipt=Get-Content "$b\public-direct-wheels-build\prepared.json" -Raw|ConvertFrom-Json
 if($receipt.source_head -ne '500168b15b105576ebc11cc43bdaed3eb87d39da' -or $receipt.changed_lines -ne 1 -or $receipt.build_method -ne 'direct-wheels' -or @($receipt.verified_wheels).Count -ne 2){throw 'Unexpected prepared build identity'}
 if((Get-FileHash $recipe -Algorithm SHA256).Hash -ne $receipt.dockerfile_sha256){throw 'Prepared recipe drift'}
 if((Get-FileHash "$source\requirements.txt" -Algorithm SHA256).Hash -ne $receipt.requirements_sha256){throw 'Requirements drift'}
 $head=& git -C $source rev-parse HEAD
 if($LASTEXITCODE -ne 0 -or $head -ne $receipt.source_head){throw 'Source head drift'}
 $dirty=& git -C $source status --porcelain
 if($LASTEXITCODE -ne 0 -or $dirty){throw 'Preserve dirty source'}
 $entries=@(Get-ChildItem $wheels -Force)
 if($entries.Count -ne 2){throw 'Unexpected wheel context entries'}
 foreach($expected in $receipt.verified_wheels){
  $p=Get-Item (Join-Path $wheels $expected.name)
  if($p.PSIsContainer -or ($p.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $p.Length -ne $expected.bytes -or (Get-FileHash $p.FullName -Algorithm SHA256).Hash -ne $expected.sha){throw 'Verified public wheel changed'}
 }
 & cmd.exe /d /s /c ('docker build --pull=false --progress=plain --build-context "lct_verified_wheels='+$wheels+'" -f "'+$recipe+'" -t lct-attendee:recovery-500168b1 "'+$source+'" > "'+$b+'\build-direct-wheels.log" 2>&1')
 if($LASTEXITCODE -isnot [int]){throw 'No integer Docker exit status'}
 $code=$LASTEXITCODE
} catch {[IO.File]::WriteAllText("$b\build-direct-wheels-error.txt",$_.Exception.GetType().Name+': '+$_.Exception.Message)}
finally {[IO.File]::WriteAllText("$b\build-direct-wheels-exit.txt",[string]$code)}
exit $code
