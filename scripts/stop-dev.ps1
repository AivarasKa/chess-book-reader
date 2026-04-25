$ErrorActionPreference = "SilentlyContinue"

$ports = @(8123, 5173)
$killed = @()

foreach ($port in $ports) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) { continue }

    $ownerPids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($ownerPid in $ownerPids) {
        if (-not $ownerPid -or $ownerPid -eq $PID) { continue }

        # Kill owner and direct children (uvicorn --reload runs as parent/child).
        $targets = @($ownerPid)
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownerPid" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty ProcessId
        if ($children) { $targets += $children }

        foreach ($targetPid in ($targets | Select-Object -Unique)) {
            Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
            $killed += [PSCustomObject]@{ Port = $port; PID = $targetPid }
        }
    }
}

if ($killed.Count -eq 0) {
    Write-Output "No dev listeners found on ports 8123/5173."
} else {
    Write-Output "Stopped processes:"
    $killed | Sort-Object Port, PID | Format-Table -AutoSize
}
