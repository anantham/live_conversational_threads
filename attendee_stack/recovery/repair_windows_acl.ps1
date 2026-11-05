param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:USERPROFILE '.lct-recovery\20261017\private'
$runtime = Join-Path $base 'stack'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.User
$taskUser = (Get-ScheduledTask -TaskName 'LCT-Attendee-Build-20261017').Principal.UserId
$taskSid = [Security.Principal.NTAccount]::new($taskUser).Translate([Security.Principal.SecurityIdentifier])
if ($taskSid.Value -ne $owner.Value) { throw 'Repair identity differs from the verified Docker task account' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use the existing elevated SSH session of the same user for ACL repair only' }
foreach ($parent in @($env:USERPROFILE, (Join-Path $env:USERPROFILE '.lct-recovery'), (Join-Path $env:USERPROFILE '.lct-recovery\20261017'), $base)) {
    if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refuse parent reparse point' }
}
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$names = @('runtime.env','compose.json','settings.py','bootstrap.py','cloud_api.py','audio_range.py')
$paths = @($runtime) + @($names | ForEach-Object { Join-Path $runtime $_ })
foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refuse reparse point' }
}
$actual = @(Get-ChildItem -LiteralPath $runtime | ForEach-Object Name | Sort-Object)
if (($actual -join '|') -ne (($names | Sort-Object) -join '|')) { throw 'Unexpected runtime contents; preserve and inspect' }
$hash = (Get-FileHash -LiteralPath (Join-Path $runtime 'runtime.env') -Algorithm SHA256).Hash
$before = @($paths | ForEach-Object { $acl = Get-Acl -LiteralPath $_; [pscustomobject]@{Path=$_;Sddl=$acl.Sddl} })
if (-not $Apply) {
    [pscustomobject]@{Mode='dry-run';Runtime=$runtime;OwnerAccount=$identity.Name;Files=$names;Grant='current user and SYSTEM only';ContentsChanged=$false} | ConvertTo-Json -Compress
    exit 0
}
$backup = Join-Path $base 'acl-before-owner-correction.json'
$stream = [IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$writer = [IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false))
try { $writer.Write(($before | ConvertTo-Json -Depth 3)) } finally { $writer.Dispose() }
foreach ($path in $paths) {
    $directory = (Get-Item -LiteralPath $path).PSIsContainer
    $acl = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true,$false)
    $inherit = if ($directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @($owner,$system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
    $verified = Get-Acl -LiteralPath $path
    $rules = @($verified.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    $sids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
    if ($rules.Count -ne 2 -or ($sids -join '|') -ne ((@($owner.Value,$system.Value) | Sort-Object) -join '|') -or @($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count) { throw 'ACL postcondition failed; do not start services' }
}
if ((Get-FileHash -LiteralPath (Join-Path $runtime 'runtime.env') -Algorithm SHA256).Hash -ne $hash) { throw 'Credential contents changed; do not start services' }
[pscustomobject]@{Mode='applied';AllowedAccounts='current user and SYSTEM only';CredentialBytesPreserved=$true;ServicesStarted=$false;Backup=$backup} | ConvertTo-Json -Compress
exit 0
