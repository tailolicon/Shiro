$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$RelayRoot = Join-Path $RepoRoot 'relay\chatgpt-bridge'
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$env:ENV_FILE = Join-Path $RuntimeRoot 'state\chatgpt-relay.env'
$env:BRIDGE_EXTENSION_TARGET_DIR = Join-Path $RuntimeRoot 'chatgpt-extension'

Push-Location $RelayRoot
try {
    & node src/index.js --server
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
