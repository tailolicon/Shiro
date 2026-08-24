param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [int]$WebPort = 3080,
    [int]$McpPort = 23157
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$EngineRoot = Join-Path $RepoRoot 'engine'
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$TokenFile = Join-Path $RuntimeRoot 'state\bridge-token.txt'
$RelayEnvFile = Join-Path $RuntimeRoot 'state\chatgpt-relay.env'

if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
    throw "Shiro's private bridge token is missing. Run Start-Shiro.ps1 first."
}
if (-not (Test-Path -LiteralPath $RelayEnvFile -PathType Leaf)) {
    throw "Shiro's private ChatGPT relay configuration is missing. Run Start-Shiro.ps1 first."
}

$RelaySettings = @{}
foreach ($Line in Get-Content -LiteralPath $RelayEnvFile) {
    if ($Line -match '^\s*([^#=]+)=(.*)$') { $RelaySettings[$Matches[1].Trim()] = $Matches[2].Trim() }
}
if ([string]::IsNullOrWhiteSpace($RelaySettings.API_TOKEN)) {
    throw "Shiro's private ChatGPT relay API token is missing."
}

$env:DSH_HOME = Join-Path $RuntimeRoot 'dsh-home'
$env:DSH_AGENTS_HOME = Join-Path $RuntimeRoot 'agents'
$env:SHIRO_WORKSPACE_ROOT = (Resolve-Path -LiteralPath $ProjectRoot).Path
$env:SHIRO_BRIDGE_TOKEN = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
$env:SHIRO_BRIDGE_PORT = [string]$McpPort
$RelayPort = if ([string]::IsNullOrWhiteSpace($RelaySettings.PORT)) { '23158' } else { $RelaySettings.PORT }
$env:SHIRO_RELAY_URL = "http://127.0.0.1:$RelayPort"
$env:SHIRO_RELAY_API_TOKEN = $RelaySettings.API_TOKEN
$env:SHIRO_RELAY_MODEL = 'GPT-5.6 Sol'
$env:DSH_CLIENT_TITLE = 'Shiro'

Push-Location $EngineRoot
try {
    & pnpm dsh --profile web --no-open --host 127.0.0.1 --port $WebPort
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
