$ErrorActionPreference = 'Stop'
$repoPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helperPath = Join-Path $repoPath 'extension'
$archivePath = Join-Path $repoPath 'frontend/public/windwatch-video-helper.zip'
$helperFiles = @('manifest.json', 'background.js', 'bridge.js', 'detector.js', 'popup.html', 'popup.js', 'README.md') | ForEach-Object { Join-Path $helperPath $_ }
Compress-Archive -LiteralPath $helperFiles -DestinationPath $archivePath -Force
Write-Output "Video helper packaged: $archivePath"
