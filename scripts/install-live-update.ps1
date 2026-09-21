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

$sourceManifest = Get-Content -LiteralPath (Join-Path $resolvedSource 'package.json') -Raw | ConvertFrom-Json
$bootstrapDirectory = Join-Path $releaseRoot "NEXIOM-$($sourceManifest.version)-win-x64"
$bootstrapExecutable = Join-Path $bootstrapDirectory 'NEXIOM.exe'
if (-not $resolvedCurrent.Equals($bootstrapDirectory, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $bootstrapExecutable -PathType Leaf)) {
    try {
        Write-UpdateLog "bootstrap-waiting pid=$CurrentProcessId target=$bootstrapExecutable"
        $bootstrapProcess = Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue
        if ($null -ne $bootstrapProcess) {
            Wait-Process -InputObject $bootstrapProcess -Timeout 32767 -ErrorAction SilentlyContinue
        }
        if ($null -ne (Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue)) {
            throw 'NEXIOM did not exit before the bootstrap timeout.'
        }
        & (Join-Path $resolvedSource 'scripts\create-shortcut.ps1') -ExecutablePath $bootstrapExecutable | Out-Null
        Start-Process -FilePath $bootstrapExecutable -WorkingDirectory $bootstrapDirectory
        Write-UpdateLog 'bootstrap-started'
        exit 0
    } catch {
        Write-UpdateLog "bootstrap-failed $($_.Exception.Message)"
        $currentExecutable = Join-Path $resolvedCurrent 'NEXIOM.exe'
        if (Test-Path -LiteralPath $currentExecutable -PathType Leaf) {
            & (Join-Path $resolvedSource 'scripts\create-shortcut.ps1') -ExecutablePath $currentExecutable | Out-Null
            Start-Process -FilePath $currentExecutable -WorkingDirectory $resolvedCurrent
        }
        throw
    }
}

if (-not [System.IO.Path]::GetDirectoryName($resolvedStaging).Equals($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $stagingName -notmatch '^\.nexiom-update-[0-9a-f-]+$') {
    throw 'The update staging directory is not trusted.'
}
if (-not [System.IO.Path]::GetDirectoryName($resolvedCurrent).Equals($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $currentName -notmatch '^NEXIOM-(?:current|\d+\.\d+\.\d+)-win-x64$') {
    throw 'The current NEXIOM release directory is not trusted.'
}
if (-not (Test-Path -LiteralPath (Join-Path $resolvedStaging 'NEXIOM.exe') -PathType Leaf)) {
    throw 'The update package does not contain NEXIOM.exe.'
}

try {
    Write-UpdateLog "waiting-for-process pid=$CurrentProcessId"
    $running = Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue
    if ($null -ne $running) {
        Wait-Process -InputObject $running -Timeout 90 -ErrorAction SilentlyContinue
    }
    if ($null -ne (Get-Process -Id $CurrentProcessId -ErrorAction SilentlyContinue)) {
        throw 'NEXIOM did not exit safely within 90 seconds.'
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
    $rollbackExecutable = if (Test-Path -LiteralPath (Join-Path $canonical 'NEXIOM.exe') -PathType Leaf) {
        Join-Path $canonical 'NEXIOM.exe'
    } else {
        Join-Path $resolvedCurrent 'NEXIOM.exe'
    }
    if (Test-Path -LiteralPath $rollbackExecutable -PathType Leaf) {
        & (Join-Path $resolvedSource 'scripts\create-shortcut.ps1') -ExecutablePath $rollbackExecutable | Out-Null
    }
    throw
}
