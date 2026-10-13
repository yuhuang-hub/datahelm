# Kill electron instances listening on debug ports (test instances only).
# Matches CIM Win32_Process: electron.exe AND CommandLine contains remote-debugging-port=<port>.
# The user's production instance runs WITHOUT a debug port and is never matched.
# ASCII-only comments (PS 5.1 misreads BOM-less UTF-8 Chinese as ANSI -> parse errors).
param([int[]]$Ports = (9222..9230))

$ids = New-Object System.Collections.Generic.List[int]
foreach ($p in $Ports) {
  $pat = '*remote-debugging-port=' + $p + '*'
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -like $pat }
  foreach ($proc in $procs) {
    Write-Output ("KILL pid=" + $proc.ProcessId + " port=" + $p)
    $ids.Add([int]$proc.ProcessId)
  }
}
foreach ($id in $ids) {
  taskkill /PID $id /T /F 2>$null | Out-Null
}
Start-Sleep -Milliseconds 600
Write-Output 'KILL-PORTS-OK'
