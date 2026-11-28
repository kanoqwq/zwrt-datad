# Native path/rollback/cleanup smoke test; never touches a device or real package.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture = Join-Path $repoRoot ('build/.deploy-kano-test-' + [Guid]::NewGuid().ToString('N'))
if (!$fixture.StartsWith((Join-Path $repoRoot 'build') + '\')) { throw 'Invalid fixture path.' }
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $scripts = Join-Path $fixture 'scripts'
    $build = Join-Path $fixture 'build'
    New-Item -ItemType Directory -Path $scripts,$build | Out-Null
    foreach ($name in @('clean-build.ps1','publish-deploy-kano.ps1')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "scripts/$name") -Destination $scripts
    }
    $output = Join-Path $build 'deploy_kano'
    $stage = Join-Path $build 'stage'
    $backup = Join-Path $build 'previous'
    New-Item -ItemType Directory -Path $output,$stage | Out-Null
    Set-Content -LiteralPath (Join-Path $output 'old') -Value 'old delivery'
    Set-Content -LiteralPath (Join-Path $stage 'package-verification.json') -Value '{}'
    & (Join-Path $scripts 'publish-deploy-kano.ps1') -StagePath $stage -OutputPath $output -BackupPath $backup
    if (!(Test-Path (Join-Path $backup 'old')) -or !(Test-Path (Join-Path $output 'package-verification.json'))) { throw 'Native publication failed.' }
    # Moving an output containing its stage invalidates the stage path. The old
    # output must be restored when the second move fails.
    $nested = Join-Path $output 'nested'
    New-Item -ItemType Directory -Path $nested | Out-Null
    Set-Content -LiteralPath (Join-Path $nested 'package-verification.json') -Value '{}'
    $failed = $false
    try { & (Join-Path $scripts 'publish-deploy-kano.ps1') -StagePath $nested -OutputPath $output -BackupPath (Join-Path $build 'rollback') }
    catch { $failed = $true }
    if (!$failed -or !(Test-Path (Join-Path $output 'package-verification.json'))) { throw 'Publication rollback failed.' }
    $cache = Join-Path $build 'qemu-check'
    $outside = Join-Path $fixture 'outside'
    New-Item -ItemType Directory -Path $cache,$outside | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'sentinel') -Value 'keep'
    New-Item -ItemType Junction -Path (Join-Path $cache 'outside-link') -Target $outside | Out-Null
    & (Join-Path $scripts 'clean-build.ps1') | Out-Null
    if (!(Test-Path -LiteralPath $cache)) { throw 'Cleanup preview modified files.' }
    & (Join-Path $scripts 'clean-build.ps1') -Apply | Out-Null
    if ((Test-Path -LiteralPath $cache) -or !(Test-Path (Join-Path $outside 'sentinel')) -or !(Test-Path (Join-Path $output 'package-verification.json'))) { throw 'Cleanup followed a link or removed the current delivery.' }
    Write-Output 'PASS: native publication, rollback, cleanup preview, junction boundary, current delivery preservation.'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
