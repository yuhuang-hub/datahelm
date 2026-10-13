$ErrorActionPreference = 'Stop'
# 杀全部测试实例（debug-port / .tmp-ud7 userData），绝不动 Roaming 用户实例
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
$killed = 0
foreach ($p in $procs) {
  $cl = $p.CommandLine
  if ($null -eq $cl) { continue }
  if ($cl -like '*remote-debugging-port*' -or $cl -like '*tmp-ud7*') {
    # 主进程（无 --type=）与子进程都杀：主进程带 remote-debugging-port；子进程带 tmp-ud7
    if ($cl -like '*AppData\Roaming*') { continue }
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
  }
}
Write-Output "KILL-TEST-OK $killed"
