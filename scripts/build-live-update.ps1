param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$StagingDirectory
)

$ErrorActionPreference = 'Stop'
$resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedSource 'release'))
$resolvedStaging = [System.IO.Path]::GetFullPath($StagingDirectory)
$stagingName = [System.IO.Path]::GetFileName($resolvedStaging)

if (-not [System.IO.Path]::GetDirectoryName($resolvedStaging).Equals($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '更新暂存目录必须是 release 的直接子目录。'
}
if ($stagingName -notmatch '^\.nexiom-update-[0-9a-f-]+$') {
    throw '更新暂存目录名称无效。'
}
if (Test-Path -LiteralPath $resolvedStaging) {
    throw "更新暂存目录已经存在：$resolvedStaging"
}

$manifestPath = Join-Path $resolvedSource 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'nexiom') {
    throw '没有找到有效的 NEXIOM 源码目录。'
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location $resolvedSource
try {
    & $npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "NEXIOM 源码构建失败，退出代码：$LASTEXITCODE"
    }
    & $node 'scripts/package-windows.mjs' '--destination' $resolvedStaging
    if ($LASTEXITCODE -ne 0) {
        throw "NEXIOM 更新包生成失败，退出代码：$LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Output $resolvedStaging
