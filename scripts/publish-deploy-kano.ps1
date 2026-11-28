param(
    [Parameter(Mandatory=$true)][string]$StagePath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$BackupPath
)
$ErrorActionPreference = 'Stop'
$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../build'))
foreach ($target in @($StagePath, $OutputPath, $BackupPath)) {
    $absolute = [IO.Path]::GetFullPath($target)
    if (!$absolute.StartsWith($buildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Publication paths must be beneath this repository build/.' }
    $parent = [IO.Path]::GetDirectoryName($absolute)
    while ($parent.Length -ge $buildRoot.Length) {
        if (Test-Path -LiteralPath $parent) {
            if (((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked publication parent.' }
        }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    if (Test-Path -LiteralPath $absolute) {
        $item = Get-Item -LiteralPath $absolute -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or !$item.PSIsContainer) { throw 'Refusing a linked or non-directory publication path.' }
    }
}
if ($StagePath -eq $OutputPath -or $StagePath -eq $BackupPath -or $OutputPath -eq $BackupPath) { throw 'Publication paths must differ.' }
if (Test-Path -LiteralPath $BackupPath) { throw 'Backup path already exists.' }
if (!(Test-Path -LiteralPath (Join-Path $StagePath 'package-verification.json'))) { throw 'Verified stage is missing.' }
$hadOutput = Test-Path -LiteralPath $OutputPath
if ($hadOutput) { Move-Item -LiteralPath $OutputPath -Destination $BackupPath }
try { Move-Item -LiteralPath $StagePath -Destination $OutputPath }
catch {
    if ($hadOutput) { Move-Item -LiteralPath $BackupPath -Destination $OutputPath }
    throw
}
