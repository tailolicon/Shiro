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
$AutoContinueRoot = Join-Path $RepoRoot 'plugins\auto-continue'
$SubagentMonitorRoot = Join-Path $RepoRoot 'plugins\subagent-monitor'
$PluginCatalogRoot = Join-Path $RepoRoot 'research\awesome-dsh-plugin'
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$DshHome = Join-Path $RuntimeRoot 'dsh-home'
$ProfileRoot = Join-Path $DshHome 'profiles\web'
$StateRoot = Join-Path $RuntimeRoot 'state'
$LogRoot = Join-Path $RuntimeRoot 'logs'
$TokenFile = Join-Path $StateRoot 'bridge-token.txt'
$BuildMarker = Join-Path $EngineRoot '.shiro-build-ready'

$AutoContinueManifest = Join-Path $AutoContinueRoot 'package.json'
$SubagentMonitorManifest = Join-Path $SubagentMonitorRoot 'package.json'
$PluginCatalogManifest = Join-Path $PluginCatalogRoot 'package.json'
$MissingPlugin = -not (Test-Path -LiteralPath $AutoContinueManifest -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $SubagentMonitorManifest -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $PluginCatalogManifest -PathType Leaf)
if ($MissingPlugin -and (Test-Path -LiteralPath (Join-Path $RepoRoot '.gitmodules') -PathType Leaf)) {
    $Git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $Git) { throw 'Git is required to initialize Shiro plugin submodules.' }
    Write-Host 'Initializing Shiro plugin submodules at their pinned revisions...'
    & $Git.Source -C $RepoRoot submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) { throw 'Shiro plugin submodule initialization failed.' }
}

foreach ($RequiredPath in @($EngineRoot, $BridgeRoot, $DesktopRoot, $AutoContinueRoot, $SubagentMonitorRoot, $PluginCatalogRoot, $ProjectRoot)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Container)) {
        throw "Required Shiro directory is missing: $RequiredPath"
    }
}
foreach ($RequiredFile in @($AutoContinueManifest, $SubagentMonitorManifest, $PluginCatalogManifest)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required pinned Shiro plugin manifest is missing: $RequiredFile"
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
$AutoContinueLink = ($AutoContinueRoot -replace '\\', '/')
$SubagentMonitorLink = ($SubagentMonitorRoot -replace '\\', '/')
$EngineLink = ($EngineRoot -replace '\\', '/')
$Profile = [ordered]@{
    name = 'shiro-profile-web'
    private = $true
    dependencies = [ordered]@{
        '@deepseek-ai/cordis' = "link:$EngineLink/vendor/cordis"
        '@deepseek-ai/schemastery' = "link:$EngineLink/vendor/schemastery"
        '@deepseek-ai/dsh-client-connection' = "link:$EngineLink/packages/client/connection"
        '@deepseek-ai/dsh-client-locale' = "link:$EngineLink/packages/client/locale"
        '@deepseek-ai/dsh-client-runtime' = "link:$EngineLink/packages/client/runtime"
        '@deepseek-ai/dsh-client-ui-layout' = "link:$EngineLink/packages/client/ui-layout"
        '@deepseek-ai/dsh-client-ui-settings' = "link:$EngineLink/packages/client/ui-settings"
        '@deepseek-ai/dsh-client-ui-settings-plugins' = "link:$EngineLink/packages/client/ui-settings-plugins"
        '@deepseek-ai/dsh-client-ui-sidebar' = "link:$EngineLink/packages/client/ui-sidebar"
        '@deepseek-ai/dsh-client-ui-slots' = "link:$EngineLink/packages/client/ui-slots"
        '@deepseek-ai/dsh-host-webserver' = "link:$EngineLink/packages/host/webserver"
        '@deepseek-ai/dsh-session' = "link:$EngineLink/packages/core/session"
        '@deepseek-ai/dsh-settings' = "link:$EngineLink/packages/settings/settings"
        '@deepseek-ai/dsh-subagent' = "link:$EngineLink/packages/subagent/subagent"
        '@deepseek-ai/dsh-tools' = "link:$EngineLink/packages/core/tools"
        '@shiro-ai/harness-bridge' = "link:$BridgeLink"
        'dsh-client-auto-continue' = "file:$AutoContinueLink"
        '@leetoners/dsh-ui-subagent-monitor' = "file:$SubagentMonitorLink"
    }
    dsh = [ordered]@{
        profile = [ordered]@{
            bundles = @(
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-web-app',
                '@shiro-ai/harness-bridge',
                'dsh-client-auto-continue',
                '@leetoners/dsh-ui-subagent-monitor'
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
        $DesktopConfig = Get-Content -Raw -LiteralPath (Join-Path $DesktopRoot 'pake.config.json') | ConvertFrom-Json
        Write-Host 'Desktop app is not built yet; opening the Shiro ChatGPT conversation in the browser.'
        Start-Process $DesktopConfig.url | Out-Null
    }
}
