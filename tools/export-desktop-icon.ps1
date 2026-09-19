param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\assets\brand')
)

Add-Type -AssemblyName System.Drawing

$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null

$sourceSegments = @(
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(31, 17),
        [System.Drawing.PointF]::new(31, 72),
        [System.Drawing.PointF]::new(46, 87),
        [System.Drawing.PointF]::new(46, 76),
        [System.Drawing.PointF]::new(39, 69),
        [System.Drawing.PointF]::new(39, 36),
        [System.Drawing.PointF]::new(66, 63),
        [System.Drawing.PointF]::new(66, 52)
    ),
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(66, 27),
        [System.Drawing.PointF]::new(66, 38),
        [System.Drawing.PointF]::new(73, 45),
        [System.Drawing.PointF]::new(73, 78),
        [System.Drawing.PointF]::new(46, 51),
        [System.Drawing.PointF]::new(46, 62),
        [System.Drawing.PointF]::new(81, 97),
        [System.Drawing.PointF]::new(81, 42)
    )
)

function New-DesktopIconBitmap {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Black)

    $canvasScale = $Size / 123.0
    $markScale = 1.1
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)

    foreach ($segment in $sourceSegments) {
        $points = [System.Drawing.PointF[]]::new($segment.Length)
        for ($index = 0; $index -lt $segment.Length; $index++) {
            $x = (61.5 + (($segment[$index].X - 56) * $markScale)) * $canvasScale
            $y = (61.5 + (($segment[$index].Y - 57) * $markScale)) * $canvasScale
            $points[$index] = [System.Drawing.PointF]::new($x, $y)
        }
        $graphics.FillPolygon($white, $points)
    }

    $white.Dispose()
    $graphics.Dispose()
    return $bitmap
}

$largeBitmap = New-DesktopIconBitmap -Size 1024
$pngPath = Join-Path $outputPath 'nexiom-desktop-icon-1024.png'
$largeBitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$largeBitmap.Dispose()

$iconSizes = @(16, 24, 32, 48, 64, 128, 256)
$payloads = [System.Collections.Generic.List[object]]::new()

foreach ($size in $iconSizes) {
    $bitmap = New-DesktopIconBitmap -Size $size
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $payloads.Add([pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() })
    $stream.Dispose()
    $bitmap.Dispose()
}

$icoPath = Join-Path $outputPath 'nexiom-desktop-icon.ico'
$icoStream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = [System.IO.BinaryWriter]::new($icoStream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$payloads.Count)

$offset = 6 + (16 * $payloads.Count)
foreach ($payload in $payloads) {
    $dimension = if ($payload.Size -eq 256) { 0 } else { $payload.Size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$payload.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $payload.Bytes.Length
}

foreach ($payload in $payloads) {
    $writer.Write($payload.Bytes)
}

$writer.Dispose()

Write-Output $pngPath
Write-Output $icoPath
