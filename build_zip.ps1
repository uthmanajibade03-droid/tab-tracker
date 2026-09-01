Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipPath = Join-Path (Get-Location) 'tab-tracker.zip'
Remove-Item -Force $zipPath -ErrorAction SilentlyContinue

$files = @(
    @{ src = 'manifest.json';        entry = 'manifest.json' },
    @{ src = 'background.js';        entry = 'background.js' },
    @{ src = 'popup.html';           entry = 'popup.html' },
    @{ src = 'popup.js';             entry = 'popup.js' },
    @{ src = 'options.html';         entry = 'options.html' },
    @{ src = 'options.js';           entry = 'options.js' },
    @{ src = 'dashboard.html';       entry = 'dashboard.html' },
    @{ src = 'dashboard.js';         entry = 'dashboard.js' },
    @{ src = 'tab-timer.js';         entry = 'tab-timer.js' },
    @{ src = 'offscreen.html';       entry = 'offscreen.html' },
    @{ src = 'offscreen.js';         entry = 'offscreen.js' },
    @{ src = 'peerjs.min.js';        entry = 'peerjs.min.js' },
    @{ src = 'icons/16.png';         entry = 'icons/16.png' },
    @{ src = 'icons/32.png';         entry = 'icons/32.png' },
    @{ src = 'icons/48.png';         entry = 'icons/48.png' },
    @{ src = 'icons/128.png';        entry = 'icons/128.png' }
)

$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        $srcPath = Join-Path (Get-Location) $f.src
        if (-not (Test-Path $srcPath)) { throw "Missing: $($f.src)" }
        $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $srcPath, $f.entry, [System.IO.Compression.CompressionLevel]::Optimal
        )
    }
}
finally {
    $archive.Dispose()
}

Write-Output "Created $zipPath"
$archive2 = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$archive2.Entries | Select-Object -ExpandProperty FullName
$archive2.Dispose()
