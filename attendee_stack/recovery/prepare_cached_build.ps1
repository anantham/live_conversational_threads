<#
Test intent: prepare only a new public build recipe; never start Docker or read secrets.
- Refuse dirty/unexpected upstream source and an existing destination.
- Preserve all requirements bytes and all Dockerfile text except one pip RUN line.
- Cache only public package downloads; preserve TLS and every upstream dependency.
#>
param(
 [Parameter(Mandatory=$true)][string]$SourceDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
if(![IO.Path]::IsPathRooted($SourceDirectory) -or ![IO.Path]::IsPathRooted($OutputDirectory)){throw 'Use absolute filesystem paths'}
$SourceDirectory=[IO.Path]::GetFullPath($SourceDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
if($OutputDirectory -eq $SourceDirectory -or $OutputDirectory.StartsWith($SourceDirectory+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Build recipe must stay outside upstream context'}
$head=& git -C $SourceDirectory rev-parse HEAD
if($LASTEXITCODE -ne 0 -or $head -ne '500168b15b105576ebc11cc43bdaed3eb87d39da'){throw 'Unexpected upstream source identity'}
$dirty=& git -C $SourceDirectory status --porcelain
if($LASTEXITCODE -ne 0 -or $dirty){throw 'Preserve dirty upstream source; do not prepare a build'}
foreach($name in @('.env','.env.local','runtime.env')){if(Test-Path (Join-Path $SourceDirectory $name)){throw 'Refuse runtime environment in build context'}}
if(Test-Path $OutputDirectory){throw 'Refuse existing public build destination'}
$original=[IO.File]::ReadAllText((Join-Path $SourceDirectory 'Dockerfile'))
$needle='RUN pip install -r requirements.txt'
$boundary=[regex]::new('(?m)^RUN pip install -r requirements\.txt(?=\r?$)')
if($boundary.Matches($original).Count -ne 1){throw 'Unexpected pip build boundary'}
$replacement='RUN --mount=type=cache,id=lct-attendee-pip-500168b1,target=/root/.cache/pip,sharing=locked pip install --timeout 120 --retries 1 -r requirements.txt'
$updated=$boundary.Replace($original,$replacement,1)
if($updated.Replace($replacement,$needle) -cne $original){throw 'Unexpected build-recipe delta'}
New-Item -ItemType Directory $OutputDirectory | Out-Null
$path=Join-Path $OutputDirectory 'Dockerfile'
[IO.File]::WriteAllText($path,$updated,[Text.UTF8Encoding]::new($false))
$receipt=@{source_head=$head;source_dockerfile_sha256=(Get-FileHash (Join-Path $SourceDirectory 'Dockerfile') -Algorithm SHA256).Hash;build_dockerfile_sha256=(Get-FileHash $path -Algorithm SHA256).Hash;requirements_sha256=(Get-FileHash (Join-Path $SourceDirectory 'requirements.txt') -Algorithm SHA256).Hash;changed_lines=1;built=$false}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'prepared.json'),($receipt|ConvertTo-Json -Compress))
$receipt|ConvertTo-Json -Compress
exit 0
