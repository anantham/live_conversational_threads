<#
One-time verified public-artifact resume for this isolated recovery.
Test intent: refuse wrong existing prefix/full first wheel/old receipt; prove native0/37 status;
require exact official completed size/SHA; retain prior receipt and partial artifacts.
No Docker, API, worker, credential or meeting operation. Positive outcome must be actual native receipt.
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$b='C:\Users\adity\.lct-recovery\20261017'
$folder=Join-Path $b 'public-verified-wheels-host'
$ready=Join-Path $b 'public-verified-wheels-host-ready'
$cv=Join-Path $folder 'opencv_python-4.10.0.84-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
$zoom=Join-Path $folder 'zoom_meeting_sdk-0.0.27-cp310-cp310-manylinux_2_28_x86_64.whl'
$code=97
if(Test-Path "$b\host-wheels-resume-exit.txt"){exit 97}
try {
 if(Test-Path $ready){throw 'Preserve existing ready context'}
 if((Get-Content "$b\host-wheels-exit.txt" -Raw).Trim() -ne '97'){throw 'Unexpected prior transport receipt'}
 $oldReceipt=(Get-FileHash "$b\host-wheels-exit.txt" -Algorithm SHA256).Hash
 if((Get-Item $cv).Length -ne 62548253 -or (Get-FileHash $cv -Algorithm SHA256).Hash -ne '9ACE140FC6D647FBE1C692BCB2ABCE768973491222C067C131D80957C595B71F'){throw 'First official wheel not complete/verified'}
 if((Get-Item $zoom).Length -ne 80113664 -or (Get-FileHash $zoom -Algorithm SHA256).Hash -ne '0B462DBF904FFE18818B201FC92B08ABEDA5BA446D7B39A0875AD263B443B3C5'){throw 'Partial bytes differ from verified Mac prefix'}
 & cmd.exe /d /s /c 'exit 0'
 $zero=$LASTEXITCODE
 & cmd.exe /d /s /c 'exit 37'
 $nonzero=$LASTEXITCODE
 if($zero -isnot [int] -or $zero -ne 0 -or $nonzero -ne 37){throw 'Native status success/refusal contract failed'}
 & cmd.exe /d /s /c ('curl.exe --fail --location --proto =https --connect-timeout 15 --max-time 600 --continue-at - --output "'+$zoom+'" "https://files.pythonhosted.org/packages/a5/50/c42c03cc1b74e19452b17669c439951a2f7135715905f91fd9a3354cf2d6/zoom_meeting_sdk-0.0.27-cp310-cp310-manylinux_2_28_x86_64.whl" > "'+$b+'\host-wheels-resume-curl.log" 2>&1')
 $nativeExit=$LASTEXITCODE
 if($nativeExit -isnot [int] -or $nativeExit -ne 0){throw 'Resumable native download failed; inspect its retained native log'}
 if((Get-Item $zoom).Length -ne 118529789 -or (Get-FileHash $zoom -Algorithm SHA256).Hash -ne '611441CA6DAC8C6BC77384B025645AF23BE1D381A539B1EA6BCD843832C0D6F8'){throw 'Completed official wheel failed size/hash'}
 New-Item -ItemType Directory $ready|Out-Null
 Copy-Item $cv $ready
 Copy-Item $zoom $ready
 if((Get-FileHash "$b\host-wheels-exit.txt" -Algorithm SHA256).Hash -ne $oldReceipt){throw 'Prior failure receipt changed'}
 [IO.File]::WriteAllText("$b\host-wheels-resume-result.json",(@{verified_files=2;total_bytes=181078042;official_hashes=$true;prefix_bytes=80113664;native_exit=$nativeExit;prior_exit_preserved=$true;ready_directory=$ready}|ConvertTo-Json -Compress))
 $code=0
} catch {[IO.File]::WriteAllText("$b\host-wheels-resume-error.txt",$_.Exception.GetType().Name+': '+$_.Exception.Message)}
finally {[IO.File]::WriteAllText("$b\host-wheels-resume-exit.txt",[string]$code)}
exit $code
