param(
    [string]$ProjectRoot,
    [int]$WebPort = 3080,
    [int]$McpPort = 23157,
    [switch]$Rebuild,
    [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = $RepoRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$EngineRoot = Join-Path $RepoRoot 'engine'
$BridgeRoot = Join-Path $RepoRoot 'bridge'
$DesktopRoot = Join-Path $RepoRoot 'desktop'
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$DshHome = Join-Path $RuntimeRoot 'dsh-home'
$ProfileRoot = Join-Path $DshHome 'profiles\web'
$StateRoot = Join-Path $RuntimeRoot 'state'
$LogRoot = Join-Path $RuntimeRoot 'logs'
$TokenFile = Join-Path $StateRoot 'bridge-token.txt'
$BuildMarker = Join-Path $EngineRoot '.shiro-build-ready'

foreach ($RequiredPath in @($EngineRoot, $BridgeRoot, $DesktopRoot, $ProjectRoot)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Container)) {
        throw "Required Shiro directory is missing: $RequiredPath"
    }
}

foreach ($Directory in @($RuntimeRoot, $DshHome, $ProfileRoot, $StateRoot, $LogRoot, (Join-Path $RuntimeRoot 'agents'))) {
    if (-not (Test-Path -LiteralPath $Directory)) {
        New-Item -ItemType Directory -Path $Directory | Out-Null
    }
}

if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
    $TokenBytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($TokenBytes)
    $Token = [Convert]::ToBase64String($TokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.File]::WriteAllText($TokenFile, $Token, [Text.UTF8Encoding]::new($false))
}

$BridgeLink = ($BridgeRoot -replace '\\', '/')
$Profile = [ordered]@{
    name = 'shiro-profile-web'
    private = $true
    dependencies = [ordered]@{
        '@deepseek-ai/dsh-tools' = "link:$(($EngineRoot -replace '\\', '/'))/packages/core/tools"
        '@shiro-ai/harness-bridge' = "link:$BridgeLink"
    }
    dsh = [ordered]@{
        profile = [ordered]@{
            bundles = @(
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-web-app',
                '@shiro-ai/harness-bridge'
            )
        }
    }
}
$ProfileJson = $Profile | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $ProfileRoot 'package.json'), $ProfileJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
foreach ($ConfigName in @('cordis.yml', 'cordis.patch.yml')) {
    $ConfigPath = Join-Path $ProfileRoot $ConfigName
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        [IO.File]::WriteAllText($ConfigPath, "[]`n", [Text.UTF8Encoding]::new($false))
    }
}

$PreviousCi = $env:CI
$env:CI = 'true'
try {
    if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'node_modules\.bin\tsx.cmd'))) {
        Write-Host 'Installing Shiro engine dependencies...'
        Push-Location $EngineRoot
        try { & pnpm install --frozen-lockfile } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Engine dependency installation failed.' }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $BridgeRoot 'node_modules\@modelcontextprotocol\sdk'))) {
        Write-Host 'Installing Shiro bridge dependencies...'
        Push-Location $BridgeRoot
        try { & pnpm install --frozen-lockfile=false } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Bridge dependency installation failed.' }
    }

    & (Join-Path $PSScriptRoot 'Setup-Shiro-Runner.ps1') -RepoRoot $RepoRoot

    Write-Host 'Linking the Shiro runtime profile...'
    Push-Location $ProfileRoot
    try { & pnpm install --frozen-lockfile=false --prefer-offline } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Runtime profile installation failed.' }

    if ($Rebuild -or -not (Test-Path -LiteralPath $BuildMarker)) {
        Write-Host 'Building the Shiro engine...'
        $env:DSH_CLIENT_TITLE = 'Shiro'
        Push-Location $EngineRoot
        try { & pnpm build } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Shiro engine build failed.' }
        [IO.File]::WriteAllText($BuildMarker, (Get-Date).ToString('o'), [Text.UTF8Encoding]::new($false))
    }
} finally {
    $env:CI = $PreviousCi
}

$Healthy = $false
try {
    $Current = Invoke-RestMethod -Uri "http://127.0.0.1:$McpPort/health" -TimeoutSec 2
    if ($Current.ok -and $Current.workspaceRoot -eq $ProjectRoot) {
        $Healthy = $true
    } else {
        throw "Port $McpPort is already used by a Shiro/Harness instance locked to $($Current.workspaceRoot). Stop it before changing ProjectRoot."
    }
} catch {
    if ($_.Exception.Message -like 'Port * is already used*') { throw }
}

if (-not $Healthy) {
    $BackendScript = Join-Path $PSScriptRoot 'Run-Shiro-Backend.ps1'
    $StdoutLog = Join-Path $LogRoot 'backend.stdout.log'
    $StderrLog = Join-Path $LogRoot 'backend.stderr.log'
    $Arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $BackendScript,
        '-ProjectRoot', $ProjectRoot, '-WebPort', [string]$WebPort, '-McpPort', [string]$McpPort
    )
    $Backend = Start-Process -FilePath PowerShell.exe -ArgumentList $Arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog
    [IO.File]::WriteAllText((Join-Path $StateRoot 'backend-process-id.txt'), [string]$Backend.Id, [Text.UTF8Encoding]::new($false))

    Write-Host 'Starting Shiro locally...'
    for ($Attempt = 0; $Attempt -lt 180; $Attempt++) {
        Start-Sleep -Milliseconds 500
        if ($Backend.HasExited) {
            $Detail = if (Test-Path -LiteralPath $StderrLog) { (Get-Content -Tail 30 -LiteralPath $StderrLog) -join [Environment]::NewLine } else { '' }
            throw "Shiro backend exited early.`n$Detail"
        }
        try {
            $Current = Invoke-RestMethod -Uri "http://127.0.0.1:$McpPort/health" -TimeoutSec 1
            if ($Current.ok -and $Current.workspaceRoot -eq $ProjectRoot) { $Healthy = $true; break }
        } catch {
        }
    }
    if (-not $Healthy) { throw "Shiro did not become ready. Logs: $LogRoot" }
}

Write-Host "Shiro is ready: http://127.0.0.1:$WebPort/"
Write-Host "Locked project root: $ProjectRoot"

if (-not $NoDesktop) {
    $DesktopApp = Join-Path $DesktopRoot 'dist\Shiro.exe'
    if (Test-Path -LiteralPath $DesktopApp -PathType Leaf) {
        Start-Process -FilePath $DesktopApp | Out-Null
    } else {
        Write-Host 'Desktop app is not built yet; opening the local UI in the browser.'
        Start-Process "http://127.0.0.1:$WebPort/" | Out-Null
    }
}
