param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$StagingDirectory,
    [Parameter(Mandatory = $true)]
    [int]$CurrentProcessId,
    [Parameter(Mandatory = $true)]
    [string]$CurrentDirectory
)

$ErrorActionPreference = 'Stop'
$resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedSource 'release'))
$resolvedStaging = (Resolve-Path -LiteralPath $StagingDirectory).ProviderPath
$resolvedCurrent = [System.IO.Path]::GetFullPath($CurrentDirectory)
$stagingName = [System.IO.Path]::GetFileName($resolvedStaging)
$currentName = [System.IO.Path]::GetFileName($resolvedCurrent)
$canonical = Join-Path $releaseRoot 'NEXIOM-current-win-x64'
$logPath = Join-Path $releaseRoot 'update.log'
$backup = $null
$installed = $false

function Write-UpdateLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}

if (-not [System.IO.Path]::GetDirectoryName($resolvedStaging).Equals($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $stagingName -notmatch '^\.nexiom-update-[0-9a-f-]+$') {
    throw '更新暂存目录不受信任。'
}
if (-not [System.IO.Path]::GetDirectoryName($resolvedCurrent).Equals($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $currentName -notmatch '^NEXIOM-(?:current|\d+\.\d+\.\d+)-win-x64$') {
    throw '当前 NEXIOM 发布目录不受信任。'
}
if (-not (Test-Path -LiteralPath (Join-Path $resolvedStaging 'NEXIOM.exe') -PathType Leaf)) {
    throw '更新包中缺少 NEXIOM.exe。'
}

try {
    Write-UpdateLog "waiting-for-process pid=$CurrentProcessId"
    $running = Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue
    if ($null -ne $running) {
        Wait-Process -InputObject $running -Timeout 90 -ErrorAction SilentlyContinue
    }
    if ($null -ne (Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue)) {
        throw 'NEXIOM 未能在 90 秒内安全退出。'
    }

    if (Test-Path -LiteralPath $canonical) {
        $backup = Join-Path $releaseRoot ".nexiom-previous-$([guid]::NewGuid().ToString())"
        Move-Item -LiteralPath $canonical -Destination $backup
    }
    Move-Item -LiteralPath $resolvedStaging -Destination $canonical
    $installed = $true

    $executable = Join-Path $canonical 'NEXIOM.exe'
    & (Join-Path $resolvedSource 'scripts\create-shortcut.ps1') -ExecutablePath $executable | Out-Null
    Start-Process -FilePath $executable -WorkingDirectory $canonical
    Write-UpdateLog 'installed-and-started'
} catch {
    Write-UpdateLog "install-failed $($_.Exception.Message)"
    if ($installed -and (Test-Path -LiteralPath $canonical) -and -not (Test-Path -LiteralPath $resolvedStaging)) {
        Move-Item -LiteralPath $canonical -Destination $resolvedStaging -ErrorAction SilentlyContinue
    }
    if ($null -ne $backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $canonical)) {
        Move-Item -LiteralPath $backup -Destination $canonical -ErrorAction SilentlyContinue
    }
    throw
}
