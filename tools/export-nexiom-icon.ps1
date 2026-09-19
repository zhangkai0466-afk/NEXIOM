param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\assets\brand')
)

Add-Type -AssemblyName System.Drawing

$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null

function New-RoundedRectanglePath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

    $black = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $tile = New-RoundedRectanglePath -X 0 -Y 0 -Width 1024 -Height 1024 -Radius 184

    $nPoints = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(250, 760),
        [System.Drawing.PointF]::new(250, 304),
        [System.Drawing.PointF]::new(290, 264),
        [System.Drawing.PointF]::new(358, 264),
        [System.Drawing.PointF]::new(666, 654),
        [System.Drawing.PointF]::new(666, 264),
        [System.Drawing.PointF]::new(738, 264),
        [System.Drawing.PointF]::new(774, 300),
        [System.Drawing.PointF]::new(774, 724),
        [System.Drawing.PointF]::new(738, 760),
        [System.Drawing.PointF]::new(666, 760),
        [System.Drawing.PointF]::new(358, 370),
        [System.Drawing.PointF]::new(358, 760),
        [System.Drawing.PointF]::new(286, 760)
    )

    $breakPoints = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(443, 548),
        [System.Drawing.PointF]::new(573, 445),
        [System.Drawing.PointF]::new(591, 468),
        [System.Drawing.PointF]::new(461, 571)
    )

    $graphics.FillPath($black, $tile)
    $graphics.FillPolygon($white, $nPoints, [System.Drawing.Drawing2D.FillMode]::Winding)
    $graphics.FillPolygon($black, $breakPoints)

    $tile.Dispose()
    $black.Dispose()
    $white.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function New-SlashIconBitmap {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

    $black = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $tile = New-RoundedRectanglePath -X 0 -Y 0 -Width 1024 -Height 1024 -Radius 184
    $bars = @(
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(322, 776),
            [System.Drawing.PointF]::new(228, 776),
            [System.Drawing.PointF]::new(322, 248),
            [System.Drawing.PointF]::new(416, 248)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(492, 505),
            [System.Drawing.PointF]::new(408, 505),
            [System.Drawing.PointF]::new(435, 354),
            [System.Drawing.PointF]::new(519, 354)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(586, 670),
            [System.Drawing.PointF]::new(502, 670),
            [System.Drawing.PointF]::new(529, 519),
            [System.Drawing.PointF]::new(613, 519)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(692, 776),
            [System.Drawing.PointF]::new(608, 776),
            [System.Drawing.PointF]::new(702, 248),
            [System.Drawing.PointF]::new(786, 248)
        )
    )

    $graphics.FillPath($black, $tile)
    foreach ($bar in $bars) {
        $graphics.FillPolygon($white, $bar)
    }

    $tile.Dispose()
    $black.Dispose()
    $white.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function New-SlashV2IconBitmap {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

    $black = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $tile = New-RoundedRectanglePath -X 0 -Y 0 -Width 1024 -Height 1024 -Radius 184
    $bars = @(
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(310, 776),
            [System.Drawing.PointF]::new(222, 776),
            [System.Drawing.PointF]::new(316, 248),
            [System.Drawing.PointF]::new(404, 248)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(698, 776),
            [System.Drawing.PointF]::new(610, 776),
            [System.Drawing.PointF]::new(704, 248),
            [System.Drawing.PointF]::new(792, 248)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(322, 340),
            [System.Drawing.PointF]::new(394, 290),
            [System.Drawing.PointF]::new(684, 684),
            [System.Drawing.PointF]::new(620, 734)
        )
    )

    $graphics.FillPath($black, $tile)
    foreach ($bar in $bars) {
        $graphics.FillPolygon($white, $bar)
    }

    $tile.Dispose()
    $black.Dispose()
    $white.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function New-SlashV3IconBitmap {
    param([int]$Size)

    $bitmap = New-SlashV2IconBitmap -Size $Size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

    $black = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $cut = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(445, 541),
        [System.Drawing.PointF]::new(549, 463),
        [System.Drawing.PointF]::new(563, 483),
        [System.Drawing.PointF]::new(459, 561)
    )
    $graphics.FillPolygon($black, $cut)

    $black.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function New-SlashV4IconBitmap {
    param([int]$Size)

    $bitmap = New-SlashV2IconBitmap -Size $Size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

    $black = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $notch = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(447, 509),
        [System.Drawing.PointF]::new(492, 569),
        [System.Drawing.PointF]::new(517, 503)
    )
    $graphics.FillPolygon($black, $notch)

    $black.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function New-SegmentedIconBitmap {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.ScaleTransform($Size / 1024.0, $Size / 1024.0)

    $black = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $tile = New-RoundedRectanglePath -X 0 -Y 0 -Width 1024 -Height 1024 -Radius 184
    $segments = @(
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(282, 220),
            [System.Drawing.PointF]::new(364, 220),
            [System.Drawing.PointF]::new(802, 804),
            [System.Drawing.PointF]::new(720, 804)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(656, 220),
            [System.Drawing.PointF]::new(738, 220),
            [System.Drawing.PointF]::new(866, 390),
            [System.Drawing.PointF]::new(784, 390)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(660, 424),
            [System.Drawing.PointF]::new(742, 424),
            [System.Drawing.PointF]::new(870, 594),
            [System.Drawing.PointF]::new(788, 594)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(186, 430),
            [System.Drawing.PointF]::new(268, 430),
            [System.Drawing.PointF]::new(396, 600),
            [System.Drawing.PointF]::new(314, 600)
        ),
        [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(188, 634),
            [System.Drawing.PointF]::new(270, 634),
            [System.Drawing.PointF]::new(398, 804),
            [System.Drawing.PointF]::new(316, 804)
        )
    )

    $graphics.FillPath($black, $tile)
    foreach ($segment in $segments) {
        $graphics.FillPolygon($white, $segment)
    }

    $tile.Dispose()
    $black.Dispose()
    $white.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function Export-PngBackedIcon {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $pngStream = [System.IO.MemoryStream]::new()
    $Bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngStream.ToArray()
    $pngStream.Dispose()

    $icoStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    $writer = [System.IO.BinaryWriter]::new($icoStream)
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]1)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$pngBytes.Length)
    $writer.Write([uint32]22)
    $writer.Write($pngBytes)
    $writer.Dispose()
}

$largeBitmap = New-IconBitmap -Size 1024
$pngPath = Join-Path $outputPath 'nexiom-icon-1024.png'
$largeBitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$largeBitmap.Dispose()

$icoBitmap = New-IconBitmap -Size 256
$icoPath = Join-Path $outputPath 'nexiom.ico'
Export-PngBackedIcon -Bitmap $icoBitmap -Path $icoPath
$icoBitmap.Dispose()

$slashBitmap = New-SlashIconBitmap -Size 1024
$slashPngPath = Join-Path $outputPath 'nexiom-icon-slash-1024.png'
$slashBitmap.Save($slashPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$slashBitmap.Dispose()

$slashIcoBitmap = New-SlashIconBitmap -Size 256
$slashIcoPath = Join-Path $outputPath 'nexiom-slash.ico'
Export-PngBackedIcon -Bitmap $slashIcoBitmap -Path $slashIcoPath
$slashIcoBitmap.Dispose()

$slashV2Bitmap = New-SlashV2IconBitmap -Size 1024
$slashV2PngPath = Join-Path $outputPath 'nexiom-icon-slash-v2-1024.png'
$slashV2Bitmap.Save($slashV2PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$slashV2Bitmap.Dispose()

$slashV2IcoBitmap = New-SlashV2IconBitmap -Size 256
$slashV2IcoPath = Join-Path $outputPath 'nexiom-slash-v2.ico'
Export-PngBackedIcon -Bitmap $slashV2IcoBitmap -Path $slashV2IcoPath
$slashV2IcoBitmap.Dispose()

$slashV3Bitmap = New-SlashV3IconBitmap -Size 1024
$slashV3PngPath = Join-Path $outputPath 'nexiom-icon-slash-v3-1024.png'
$slashV3Bitmap.Save($slashV3PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$slashV3Bitmap.Dispose()

$slashV3IcoBitmap = New-SlashV3IconBitmap -Size 256
$slashV3IcoPath = Join-Path $outputPath 'nexiom-slash-v3.ico'
Export-PngBackedIcon -Bitmap $slashV3IcoBitmap -Path $slashV3IcoPath
$slashV3IcoBitmap.Dispose()

$slashV4Bitmap = New-SlashV4IconBitmap -Size 1024
$slashV4PngPath = Join-Path $outputPath 'nexiom-icon-slash-v4-1024.png'
$slashV4Bitmap.Save($slashV4PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$slashV4Bitmap.Dispose()

$slashV4IcoBitmap = New-SlashV4IconBitmap -Size 256
$slashV4IcoPath = Join-Path $outputPath 'nexiom-slash-v4.ico'
Export-PngBackedIcon -Bitmap $slashV4IcoBitmap -Path $slashV4IcoPath
$slashV4IcoBitmap.Dispose()

$segmentedBitmap = New-SegmentedIconBitmap -Size 1024
$segmentedPngPath = Join-Path $outputPath 'nexiom-icon-segmented-1024.png'
$segmentedBitmap.Save($segmentedPngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$segmentedBitmap.Dispose()

$segmentedIcoBitmap = New-SegmentedIconBitmap -Size 256
$segmentedIcoPath = Join-Path $outputPath 'nexiom-segmented.ico'
Export-PngBackedIcon -Bitmap $segmentedIcoBitmap -Path $segmentedIcoPath
$segmentedIcoBitmap.Dispose()

Write-Output $pngPath
Write-Output $icoPath
Write-Output $slashPngPath
Write-Output $slashIcoPath
Write-Output $slashV2PngPath
Write-Output $slashV2IcoPath
Write-Output $slashV3PngPath
Write-Output $slashV3IcoPath
Write-Output $slashV4PngPath
Write-Output $slashV4IcoPath
Write-Output $segmentedPngPath
Write-Output $segmentedIcoPath
