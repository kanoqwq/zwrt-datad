param(
    [string]$BaseUrl = '',
    [string]$AdbDir = '',
    [string]$Zig = '',
    [string]$ConfigFile = '',
    [switch]$PackageOnly,
    [switch]$ApiOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$ConfigFile) { $ConfigFile = Join-Path $repoRoot 'local/deploy-kano.json' }
if (Test-Path -LiteralPath $ConfigFile) {
    $config = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
    if (!$BaseUrl) { $BaseUrl = $config.base_url }
    if (!$AdbDir) { $AdbDir = $config.adb_dir }
    if (!$Zig) { $Zig = $config.zig }
}
if (!$BaseUrl -and $env:DATAD_BASE_URL) { $BaseUrl = $env:DATAD_BASE_URL }
if (!$AdbDir) {
    $adb = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($adb) { $AdbDir = Split-Path $adb.Source }
}
if (!$AdbDir) { throw 'Pass -AdbDir with the Windows Android platform-tools directory.' }
$AdbDir = (Resolve-Path -LiteralPath $AdbDir).Path
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)." }
}
Push-Location $repoRoot
try {
    $linuxRoot = (& wsl.exe --exec wslpath -a -u $repoRoot).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the repository in WSL.' }
    $linuxAdb = (& wsl.exe --exec wslpath -a -u $AdbDir).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve platform-tools in WSL.' }
    if (!$Zig) {
        $Zig = (& wsl.exe --exec python3 -c "import pathlib,shutil; print(shutil.which('zig') or str(pathlib.Path.home()/'zig/zig'))").Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot locate Linux Zig.' }
    }
    if (!$PackageOnly) {
        if (!$ApiOnly) {
            Invoke-Checked 'npm.cmd' @('ci', '--prefix', 'web')
            Invoke-Checked 'npm.cmd' @('run', 'build', '--prefix', 'web')
        }
        if ($ApiOnly) {
            Invoke-Checked 'wsl.exe' @('--exec', 'env', "ZIG=$Zig", 'bash', '-l', "$linuxRoot/scripts/build-arm32-candidate.sh")
        } else {
            Invoke-Checked 'wsl.exe' @('--exec', 'env', "ZIG=$Zig", 'bash', '-l', "$linuxRoot/scripts/build-arm32-web.sh", '--candidate')
        }
    }
    Invoke-Checked 'wsl.exe' @('--exec', 'sh', "$linuxRoot/tools/u50get/build.sh")
    $packageArgs = @('--exec', 'python3', "$linuxRoot/scripts/package-deploy-kano.py", '--adb-dir', $linuxAdb)
    if ($BaseUrl) { $packageArgs += @('--base-url', $BaseUrl) }
    if ($ApiOnly) { $packageArgs += '--api-only' }
    Invoke-Checked 'wsl.exe' $packageArgs
    Write-Host 'Verified delivery: build/deploy_kano/package-verification.json'
} finally { Pop-Location }
