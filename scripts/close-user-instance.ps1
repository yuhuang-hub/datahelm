# Kill old user DataHelm instance (electron, no DH_TEST marker, no remote-debugging-port)
Get-CimInstance Win32_Process -Filter "Name like '%electron%'" | ForEach-Object {
  $cl = $_.CommandLine
  if ($cl -and $cl -like '*DataHelm*' -and $cl -notlike '*DH_TEST*' -and $cl -notlike '*remote-debugging-port*') {
    $short = $cl.Substring(0, [Math]::Min(90, $cl.Length))
    Write-Output ("KILL " + $_.ProcessId + " :: " + $short)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Write-Output 'done'
