$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$PidFile = Join-Path $RuntimeRoot 'state\backend-process-id.txt'

if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
    Write-Host 'No Shiro backend process is registered.'
    exit 0
}

$ProcessId = [int](Get-Content -Raw -LiteralPath $PidFile).Trim()
$Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
if ($null -eq $Process) {
    Remove-Item -LiteralPath $PidFile -Force
    Write-Host 'Shiro is already stopped.'
    exit 0
}
if ($Process.CommandLine -notlike '*Run-Shiro-Backend.ps1*') {
    throw "Refusing to stop PID $ProcessId because it is not the registered Shiro backend."
}

Stop-Process -Id $ProcessId
Remove-Item -LiteralPath $PidFile -Force
Write-Host 'Shiro backend stopped.'
