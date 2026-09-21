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
    throw 'The update staging directory must be a direct child of release.'
}
if ($stagingName -notmatch '^\.nexiom-update-[0-9a-f-]+$') {
    throw 'The update staging directory name is invalid.'
}
if (Test-Path -LiteralPath $resolvedStaging) {
    throw "The update staging directory already exists: $resolvedStaging"
}

$manifestPath = Join-Path $resolvedSource 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'nexiom') {
    throw 'The NEXIOM source directory is invalid.'
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location $resolvedSource
try {
    & $npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "The NEXIOM source build failed with exit code $LASTEXITCODE."
    }
    & $node 'scripts/package-windows.mjs' '--destination' $resolvedStaging
    if ($LASTEXITCODE -ne 0) {
        throw "The NEXIOM update package failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Write-Output $resolvedStaging
