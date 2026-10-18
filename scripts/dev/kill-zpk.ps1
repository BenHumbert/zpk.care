# Stops every node.exe that belongs to zpk_care work on this machine, and nothing else.
# Run as a file so no shell quoting can alter the filter. Reports matches before and after.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/kill-zpk.ps1
#
# `npm run kill:ports` frees the well-known ports; this also catches the workers and the
# harness, which hold no port, and leaves every unrelated node process alone.
$patterns = 'zpk_care|start-leviathan|e2e-verify|hr-tool-server|proof-pool-worker|l2-verify-worker|l2-proving-worker'
$exclude  = 'Adobe|SwapStreet|lan\.mjs|bots-join'

function Get-ZpkNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine -match $patterns) -and -not ($_.CommandLine -match $exclude)
  }
}

$procs = @(Get-ZpkNode)
Write-Output "matched before: $($procs.Count)"
foreach ($p in $procs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Output "  stopped $($p.ProcessId)" }
  catch { Write-Output "  could not stop $($p.ProcessId): $($_.Exception.Message)" }
}
Start-Sleep -Seconds 2
$after = @(Get-ZpkNode)
Write-Output "matched after: $($after.Count)"
$ports = @(3030, 3031, 3032, 4001, 4002, 4003, 4004, 4040, 5050, 8000)
$listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort })
Write-Output "zpk ports listening: $($listening.Count)"
$others = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { -not ($_.CommandLine -match $patterns) })
Write-Output "other node processes left untouched: $($others.Count)"
