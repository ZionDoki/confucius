param([string]$Path, [string]$ReadyPath, [string]$ReleasePath)
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  [System.IO.File]::WriteAllText($ReadyPath, 'locked')
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not [System.IO.File]::Exists($ReleasePath) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
} finally { $stream.Dispose() }
