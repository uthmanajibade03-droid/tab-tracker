# Pads/scales any image to 1280x800 (Chrome Web Store screenshot size).
# Usage: .\_pad_screenshot.ps1 -src "C:\path\to\input.png" -out "screenshot1.png"

param(
    [Parameter(Mandatory=$true)][string]$src,
    [Parameter(Mandatory=$true)][string]$out,
    [int]$w = 1280,
    [int]$h = 800,
    [string]$bgHex = "FAFAFC"
)

Add-Type -AssemblyName System.Drawing

$srcPath = (Resolve-Path $src).Path
$srcImg = [System.Drawing.Image]::FromFile($srcPath)

$bg = New-Object System.Drawing.Bitmap $w, $h
$g  = [System.Drawing.Graphics]::FromImage($bg)
$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$r = [Convert]::ToInt32($bgHex.Substring(0,2), 16)
$gC = [Convert]::ToInt32($bgHex.Substring(2,2), 16)
$b = [Convert]::ToInt32($bgHex.Substring(4,2), 16)
$g.Clear([System.Drawing.Color]::FromArgb(255, $r, $gC, $b))

# Scale source to fit inside (w-40) x (h-40) preserving aspect ratio
$pad = 20
$maxW = $w - 2 * $pad
$maxH = $h - 2 * $pad
$scale = [Math]::Min([double]$maxW / $srcImg.Width, [double]$maxH / $srcImg.Height)
if ($scale -gt 1.0) { $scale = 1.0 }  # never upscale
$nw = [int]($srcImg.Width * $scale)
$nh = [int]($srcImg.Height * $scale)
$x = [int](($w - $nw) / 2)
$y = [int](($h - $nh) / 2)

$g.DrawImage($srcImg, $x, $y, $nw, $nh)
$g.Dispose()

$outPath = if ([System.IO.Path]::IsPathRooted($out)) { $out } else { Join-Path (Get-Location) $out }
$bg.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bg.Dispose()
$srcImg.Dispose()

Write-Output "Saved $outPath ($w x $h)"
