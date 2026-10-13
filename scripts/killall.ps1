param([int[]]$Ports = @(9222,9225,9226,9227,9228,9229))
# Kill only test debug-port listeners (never the user production instance, which runs without a debug port).
foreach ($p in $Ports) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}
$deadline = (Get-Date).AddSeconds(12)
$left = @()
do {
  Start-Sleep -Milliseconds 500
  $left = @(Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue)
} while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
if ($left.Count -gt 0) { Write-Output 'STILL-LISTENING'; exit 1 } else { Write-Output 'PORTS-FREE' }
