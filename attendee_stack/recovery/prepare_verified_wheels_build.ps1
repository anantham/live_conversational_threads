<#
Test intent: verify exactly two unchanged official upstream wheels, outside the source.
Refuse source/hash/path drift, private/unexpected/link files and existing output.
Change only the pip RUN; never start Docker, access secrets or replace old receipts.
#>
param(
 [Parameter(Mandatory=$true)][string]$SourceDirectory,
 [Parameter(Mandatory=$true)][string]$WheelhouseDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
foreach($path in @($SourceDirectory,$WheelhouseDirectory,$OutputDirectory)){
 if(![IO.Path]::IsPathRooted($path)){throw 'Use absolute filesystem paths'}
}
$SourceDirectory=[IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\')
$WheelhouseDirectory=[IO.Path]::GetFullPath($WheelhouseDirectory).TrimEnd('\')
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
foreach($path in @($WheelhouseDirectory,$OutputDirectory)){
 if($path -eq $SourceDirectory -or $path.StartsWith($SourceDirectory+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Public artifacts must stay outside upstream context'}
}
if($OutputDirectory -eq $WheelhouseDirectory -or $OutputDirectory.StartsWith($WheelhouseDirectory+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Build recipe must stay outside the public wheel context'}
if(Test-Path $OutputDirectory){throw 'Refuse existing build destination'}
$head=& git -C $SourceDirectory rev-parse HEAD
if($LASTEXITCODE -ne 0 -or $head -ne '500168b15b105576ebc11cc43bdaed3eb87d39da'){throw 'Unexpected upstream source'}
$dirty=& git -C $SourceDirectory status --porcelain
if($LASTEXITCODE -ne 0 -or $dirty){throw 'Preserve dirty upstream source'}
foreach($name in @('.env','.env.local','runtime.env')){if(Test-Path (Join-Path $SourceDirectory $name)){throw 'Runtime environment in build context'}}
if((Get-FileHash (Join-Path $SourceDirectory 'requirements.txt') -Algorithm SHA256).Hash -ne '85FE4FFF222C8BF4D5EDC02D023B64D3BFF40FDEB9A2678D5B6FA0AB1C592F3E'){throw 'Upstream requirements drift'}
if((Get-FileHash (Join-Path $SourceDirectory 'Dockerfile') -Algorithm SHA256).Hash -ne '715B0FB4D2056B093AA146E80B78F578C6B2496C4E44A43FAC4BE25212792A72'){throw 'Upstream Dockerfile drift'}
$expected=@(
 @{name='opencv_python-4.10.0.84-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl';bytes=62548253;sha='9ACE140FC6D647FBE1C692BCB2ABCE768973491222C067C131D80957C595B71F'},
 @{name='zoom_meeting_sdk-0.0.27-cp310-cp310-manylinux_2_28_x86_64.whl';bytes=118529789;sha='611441CA6DAC8C6BC77384B025645AF23BE1D381A539B1EA6BCD843832C0D6F8'}
)
$folder=Get-Item $WheelhouseDirectory
if(!$folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Wheel context must be a real directory'}
$files=@(Get-ChildItem $WheelhouseDirectory -Force)
if($files.Count -ne 2){throw 'Wheel context must contain only the two verified public files'}
foreach($file in $files){
 $match=@($expected|Where-Object{$_.name -ceq $file.Name})
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $match.Count -ne 1){throw 'Unexpected/link entry in public wheel context'}
 if($file.Length -ne $match[0].bytes -or (Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne $match[0].sha){throw 'Official wheel size/hash mismatch'}
}
$original=[IO.File]::ReadAllText((Join-Path $SourceDirectory 'Dockerfile'))
$boundary=[regex]::new('(?m)^RUN pip install -r requirements\.txt(?=\r?$)')
if($boundary.Matches($original).Count -ne 1){throw 'Unexpected pip boundary'}
$replacement='RUN --mount=type=bind,from=lct_verified_wheels,target=/lct-wheels,readonly --mount=type=cache,id=lct-attendee-pip-500168b1,target=/root/.cache/pip,sharing=locked pip install --find-links=/lct-wheels --timeout 120 --retries 1 -r requirements.txt'
$updated=$boundary.Replace($original,$replacement,1)
if($updated.Replace($replacement,'RUN pip install -r requirements.txt') -cne $original){throw 'Unexpected Dockerfile delta'}
New-Item -ItemType Directory $OutputDirectory|Out-Null
$path=Join-Path $OutputDirectory 'Dockerfile'
[IO.File]::WriteAllText($path,$updated,[Text.UTF8Encoding]::new($false))
$receipt=@{source_head=$head;requirements_sha256=(Get-FileHash (Join-Path $SourceDirectory 'requirements.txt') -Algorithm SHA256).Hash;dockerfile_sha256=(Get-FileHash $path -Algorithm SHA256).Hash;verified_wheels=$expected;changed_lines=1;built=$false}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'prepared.json'),($receipt|ConvertTo-Json -Depth 4 -Compress))
$receipt|ConvertTo-Json -Depth 4 -Compress
exit 0
