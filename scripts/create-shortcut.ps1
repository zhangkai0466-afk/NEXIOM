param(
    [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
if (-not $ExecutablePath) {
    $portableExecutable = Join-Path $PSScriptRoot '..\NEXIOM.exe'
    if (Test-Path -LiteralPath $portableExecutable -PathType Leaf) {
        $ExecutablePath = $portableExecutable
    } else {
        $manifestPath = Join-Path $PSScriptRoot '..\package.json'
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $ExecutablePath = Join-Path $PSScriptRoot "..\release\NEXIOM-$($manifest.version)-win-x64\NEXIOM.exe"
    }
}
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).ProviderPath
if ([System.IO.Path]::GetFileName($resolvedExecutable) -ne 'NEXIOM.exe') {
    throw 'The shortcut target must be NEXIOM.exe.'
}

$applicationDirectory = Split-Path -Parent $resolvedExecutable
$iconPath = Join-Path $applicationDirectory 'resources\app\assets\brand\nexiom-desktop-icon.ico'
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "The NEXIOM icon is missing: $iconPath"
}

$desktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if (-not $desktopDirectory -or -not (Test-Path -LiteralPath $desktopDirectory -PathType Container)) {
    throw 'The Windows desktop directory is unavailable.'
}

$shortcutPath = Join-Path $desktopDirectory 'NEXIOM.lnk'
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if (Test-Path -LiteralPath $shortcutPath) {
        $existingExecutable = [System.IO.Path]::GetFileName($shortcut.TargetPath)
        if ($existingExecutable -ne 'NEXIOM.exe') {
            throw "The existing desktop shortcut points to another application: $shortcutPath"
        }
    }
    $shortcut.TargetPath = $resolvedExecutable
    $shortcut.WorkingDirectory = $applicationDirectory
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Description = 'NEXIOM - Mathematical Modeling Agent'
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    Write-Output $shortcutPath
} finally {
    if ($null -ne $shortcut) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
