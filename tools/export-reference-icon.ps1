param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\assets\brand'),
    [int]$Scale = 24
)

Add-Type -AssemblyName System.Drawing

$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
$width = 172 * $Scale
$height = 137 * $Scale

$bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Black)
$graphics.ScaleTransform($Scale, $Scale)
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)

$segments = @(
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(33.5, 28.5),
        [System.Drawing.PointF]::new(39.5, 22.5),
        [System.Drawing.PointF]::new(115, 98),
        [System.Drawing.PointF]::new(109, 104)
    ),
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(84.5, 28.5),
        [System.Drawing.PointF]::new(90.5, 22.5),
        [System.Drawing.PointF]::new(114.5, 46.5),
        [System.Drawing.PointF]::new(108.5, 52.5)
    ),
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(33.5, 53.5),
        [System.Drawing.PointF]::new(39.5, 47.5),
        [System.Drawing.PointF]::new(64.5, 72.5),
        [System.Drawing.PointF]::new(58.5, 78.5)
    ),
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(84, 54),
        [System.Drawing.PointF]::new(90.5, 47.5),
        [System.Drawing.PointF]::new(115.5, 72.5),
        [System.Drawing.PointF]::new(109, 79)
    ),
    [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(33, 79),
        [System.Drawing.PointF]::new(39.5, 72.5),
        [System.Drawing.PointF]::new(64.5, 97.5),
        [System.Drawing.PointF]::new(58, 104)
    )
)

foreach ($segment in $segments) {
    $graphics.FillPolygon($white, $segment)
}

$pngPath = Join-Path $outputPath "nexiom-reference-black-$($width)x$($height).png"
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$white.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $pngPath
