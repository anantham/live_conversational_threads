# Default: read-only gate. Apply/Rollback change only the existing public source
# behind its read-only worker bind mount. Never start a worker or create a bot.
param([switch]$Apply,[switch]$Rollback)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($Apply -and $Rollback){throw 'Choose one source operation'}
$base=(Get-Item -LiteralPath 'C:\Users\adity\.lct-recovery\20261017' -Force).FullName.TrimEnd('\')
$app='8393c66369988cc75f22445fca62e931f07b08a536fa34b09ed60bfee66a66cd'
$worker='692a6837f73c924db96a56b449c7d5f63bcd234cfccc3b9003f9f3d081d44c8a'
$image='sha256:ef5518b4ed1b31e4590f5fa86a85d36238223e0f733443a801ea271dd9f366f3'
$old='260172214810776fbe1b32e2d698a18972d9fed5ad62263b2d9dd06d9ec4c7e5'
$new='fb0e59abf406b9a7ffa69bc1804a031d68adde02ed268c33a7f20e90ecf6cbd7'
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()}
function BytesHash([byte[]]$Bytes){
    $hasher=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($hasher.ComputeHash($Bytes)).Replace('-','').ToLower()}finally{$hasher.Dispose()}
}
function WriteVerifiedPublicFile([string]$Path,[byte[]]$Content,[string]$Expected,[string]$Prior,[scriptblock]$WriteAction=$null){
    if((BytesHash $Content) -ne $Expected){throw 'Replacement bytes differ before write'}
    if((Get-Item -LiteralPath $Path -Force).IsReadOnly){throw 'Source is read-only; do not change permissions'}
    $originalAcl=(Get-Acl -LiteralPath $Path).Sddl
    $originalAttributes=(Get-Item -LiteralPath $Path -Force).Attributes
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $reader=[IO.BinaryReader]::new($stream,[Text.Encoding]::UTF8,$true)
    try{
        if($stream.Length -lt 1 -or $stream.Length -gt 500000){throw 'Unexpected public-source size'}
        $original=$reader.ReadBytes([int]$stream.Length)
        if((BytesHash $original) -ne $Prior){throw 'Current source differs after exclusive open'}
        try{
            $stream.Position=0
            if($WriteAction){& $WriteAction $stream $Content}else{$stream.Write($Content,0,$Content.Length)}
            $stream.SetLength($Content.Length);$stream.Flush($true);$stream.Position=0
            if((BytesHash ($reader.ReadBytes([int]$stream.Length))) -ne $Expected){throw 'Written source bytes differ'}
        }catch{
            $failure=$_
            try{
                $stream.Position=0;$stream.Write($original,0,$original.Length);$stream.SetLength($original.Length)
                $stream.Flush($true);$stream.Position=0
                if((BytesHash ($reader.ReadBytes([int]$stream.Length))) -ne $Prior){throw 'Restored source bytes differ'}
            }catch{throw 'Update and original-byte restoration failed; keep worker stopped and preserve immutable backup'}
            throw $failure
        }
    }finally{$reader.Dispose();$stream.Dispose()}
    if((Hash $Path) -ne $Expected -or (Get-Acl -LiteralPath $Path).Sddl -ne $originalAcl -or
       (Get-Item -LiteralPath $Path -Force).Attributes -ne $originalAttributes){throw 'Source readback differs; keep worker stopped and preserve original backup'}
}

function CheckHolders {
    $a=& docker inspect --format '{{.Id}}|{{.State.Running}}|{{.Config.User}}|{{.Image}}' $app
    if($LASTEXITCODE -ne 0 -or $a -ne ($app+'|true|app|'+$image)){throw 'Exact app runtime differs'}
    $w=& docker inspect --format '{{.Id}}|{{.State.Running}}|{{.Config.User}}|{{.Image}}|{{.Name}}' $worker
    if($LASTEXITCODE -ne 0 -or $w -ne ($worker+'|false|app|'+$image+'|/lct-meet-first-failure-20261020')){throw 'Exact worker must remain stopped'}
}
function CheckRecords {
    # Root is asserted before any framework import. Read only the dedicated
    # synthetic recovery namespace; emit counts, never participant data.
    $python=@'
import os,json
assert os.environ.get('POSTGRES_DB')=='lct_meet_recovery_20261017'
import django
django.setup()
from django.conf import settings
assert settings.DATABASES['default']['NAME']=='lct_meet_recovery_20261017' and settings.DATABASES['default']['HOST']=='postgres'
from bots.models import Bot,BotStates
bots=list(Bot.objects.select_related('project').all())
assert len(bots)==8 and all(b.project.name=='LCT isolated recovery' and BotStates.state_to_api_code(b.state) in ('ended','fatal_error','data_deleted') for b in bots)
print(json.dumps({'retained_terminal_bots':8,'active_bots':0,'database_mutated':False}))
'@
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($python))
    $code="exec(__import__('base64').b64decode('"+$encoded+"'))"
    & docker exec $app python -c $code
    if($LASTEXITCODE -ne 0){throw 'Exact retained terminal-bot gate failed'}
}
CheckHolders
$mounts=(& docker inspect --format '{{json .Mounts}}' $worker|ConvertFrom-Json)
if($LASTEXITCODE -ne 0){throw 'Worker mount inspect failed'}
$ui=@($mounts|Where-Object {$_.Destination -eq '/attendee/bots/google_meet_bot_adapter/google_meet_ui_methods.py'})
if($ui.Count -ne 1 -or $ui[0].Type -ne 'bind' -or $ui[0].RW){throw 'Expected existing read-only UI mount missing'}
$source=[IO.Path]::GetFullPath($ui[0].Source)
if(!$source.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Public source is outside approved recovery root'}
$cursor=Get-Item -LiteralPath $source -Force
$rootFound=$false
for($depth=0;$depth -lt 32;$depth++){
    if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing a linked public source path'}
    if([string]::Equals($cursor.FullName.TrimEnd('\'),$base,[StringComparison]::OrdinalIgnoreCase)){$rootFound=$true;break}
    $cursor=Get-Item -LiteralPath (Split-Path -Parent $cursor.FullName) -Force
}
if(!$rootFound){throw 'Public source ancestry did not reach the approved root'}
if((Get-Item -LiteralPath $source -Force).IsReadOnly){throw 'Host source is read-only; do not change permissions'}
$original=[IO.File]::ReadAllBytes($source);$before=BytesHash $original
if($Rollback){if($before -notin @($old,$new)){throw 'Unknown source; preserve it'}}elseif($before -ne $old){throw 'Current public source differs; preserve it'}
$candidate=Join-Path $base 'meet_language_scoped_fb0e59ab.py'
if(!$Rollback -and (Hash $candidate) -ne $new){throw 'Reviewed candidate bytes differ'}
$backup=Join-Path $base 'public-meet-language-26017221.original.py'
if(Test-Path -LiteralPath $backup){if((Hash $backup) -ne $old){throw 'Existing backup differs; preserve it'}}elseif($Rollback){throw 'Original backup missing'}
CheckRecords
$acl=(Get-Acl -LiteralPath $source).Sddl
$attributes=(Get-Item -LiteralPath $source -Force).Attributes
if($Apply -or $Rollback){
    # Preserve an exclusive immutable copy before the verified replacement.
    if(!(Test-Path -LiteralPath $backup)){
        $stream=[IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
        try{$stream.Write($original,0,$original.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        if((Hash $backup) -ne $old){throw 'Original backup readback differs; keep worker stopped'}
    }
    CheckHolders
    if((Hash $source) -ne $before){throw 'Source changed during gate; preserve it'}
    $replacement=$candidate;$expected=$new
    if($Rollback){$replacement=$backup;$expected=$old}
    $content=[IO.File]::ReadAllBytes($replacement)
    if((BytesHash $content) -ne $expected){throw 'Replacement changed during gate; preserve it'}
    WriteVerifiedPublicFile $source $content $expected $before
}
if(!$Apply -and !$Rollback){$expected=$before}
if((Hash $source) -ne $expected -or (Get-Acl -LiteralPath $source).Sddl -ne $acl -or
   (Get-Item -LiteralPath $source -Force).Attributes -ne $attributes){throw 'Source/ACL/attributes readback differs; keep worker stopped and preserve backup'}
CheckHolders
CheckRecords
@{dry_run=(!$Apply -and !$Rollback);applied=[bool]$Apply;rolled_back=[bool]$Rollback;source_sha256=(Hash $source);worker_stopped=$true;data_retained=$true;permissions_unchanged=$true;bot_created=$false;provider_called=$false}|ConvertTo-Json -Compress
