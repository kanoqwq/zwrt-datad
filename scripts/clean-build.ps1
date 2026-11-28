param([switch]$Apply, [switch]$CargoCache)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = Join-Path $repoRoot 'build'
# Explicit generated outputs only. Captures, reference checkouts, toolchains,
# the latest deploy_kano package and local configuration are never enumerated.
$relativeTargets = @(
    'build/ci-python', 'build/qemu-check', 'build/nms-debug-deps',
    'build/arm32-toolchain', 'build/efs-mock', 'build/efs-worker-aarch64',
    'build/efs-worker-armv7', 'build/u50-diag-worker', 'build/u50-diag-streamer',
    'build/smtp-auth-probe/probe'
)
if ($CargoCache) { $relativeTargets += 'rust/target' }
$targets = @()
$treeLinks = @{}
function Find-TreeLinks([string]$RootPath) {
    if (!(Get-Item -LiteralPath $RootPath -Force).PSIsContainer) { return }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($RootPath)
    while ($pending.Count) {
        foreach ($child in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $child
            } elseif ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
}
foreach ($relative in $relativeTargets) {
    $path = [IO.Path]::GetFullPath((Join-Path $repoRoot $relative))
    if (!(Test-Path -LiteralPath $path)) { continue }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing a linked target: $path" }
    $resolved = (Resolve-Path -LiteralPath $path).Path
    if (!$resolved.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        !($resolved.StartsWith($buildRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
          $resolved -eq (Join-Path $repoRoot 'rust/target'))) { throw "Unsafe cleanup target: $resolved" }
    # Do not traverse links. Remove only their directory entries before recursion.
    $treeLinks[$resolved] = @(Find-TreeLinks $resolved)
    $targets += $resolved
}
if ($Apply) {
    if (Get-Process -Name cargo,rustc,zig,go -ErrorAction SilentlyContinue) { throw 'A build process is running; retry after it finishes.' }
    $processNames = & wsl.exe --exec ps -eo comm
    if ($LASTEXITCODE -ne 0) { throw 'Cannot check WSL build processes.' }
    $running = $processNames | Where-Object { $_.Trim() -match '^(cargo(?:-.+)?|rustc|zig|go)$' }
    if ($running) { throw 'A WSL build process is running; retry after it finishes.' }
}
foreach ($path in $targets) {
    Write-Output $path
    if ($Apply) {
        foreach ($link in $treeLinks[$path]) {
            if (!$link.FullName.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe linked path.' }
            if (($link.Attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($link.FullName) }
            else { [IO.File]::Delete($link.FullName) }
        }
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}
if (!$Apply) { Write-Output 'Preview only. Pass -Apply to remove these generated outputs.' }
