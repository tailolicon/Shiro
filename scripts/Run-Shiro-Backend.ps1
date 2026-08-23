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

if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
    throw "Shiro's private bridge token is missing. Run Start-Shiro.ps1 first."
}

$env:DSH_HOME = Join-Path $RuntimeRoot 'dsh-home'
$env:DSH_AGENTS_HOME = Join-Path $RuntimeRoot 'agents'
$env:SHIRO_WORKSPACE_ROOT = (Resolve-Path -LiteralPath $ProjectRoot).Path
$env:SHIRO_BRIDGE_TOKEN = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
$env:SHIRO_BRIDGE_PORT = [string]$McpPort
$env:DSH_CLIENT_TITLE = 'Shiro'

Push-Location $EngineRoot
try {
    & pnpm dsh --profile web --no-open --host 127.0.0.1 --port $WebPort
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
