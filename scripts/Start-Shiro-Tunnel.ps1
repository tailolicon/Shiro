param(
    [string]$ProjectRoot,
    [int]$WebPort = 3080,
    [int]$McpPort = 23157,
    [string]$TunnelClient
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = $RepoRoot }
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$StateRoot = Join-Path $RuntimeRoot 'state'
$TokenFile = Join-Path $StateRoot 'bridge-token.txt'
$TunnelIdFile = Join-Path $StateRoot 'tunnel-id.txt'
$HealthUrlFile = Join-Path $StateRoot 'tunnel-health.url'
if ([string]::IsNullOrWhiteSpace($TunnelClient)) {
    $TunnelClient = Join-Path $RuntimeRoot 'tunnel\tunnel-client.exe'
}

& (Join-Path $PSScriptRoot 'Start-Shiro.ps1') -ProjectRoot $ProjectRoot -WebPort $WebPort -McpPort $McpPort -NoDesktop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path -LiteralPath $TunnelClient -PathType Leaf)) {
    throw "OpenAI tunnel client is missing: $TunnelClient"
}
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
    throw "Shiro's local bridge token is missing."
}

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_TUNNEL_ID)) {
    if (Test-Path -LiteralPath $TunnelIdFile) {
        $env:CONTROL_PLANE_TUNNEL_ID = (Get-Content -Raw -LiteralPath $TunnelIdFile).Trim()
    } else {
        $env:CONTROL_PLANE_TUNNEL_ID = Read-Host 'OpenAI tunnel ID (tunnel_...)'
        [IO.File]::WriteAllText($TunnelIdFile, $env:CONTROL_PLANE_TUNNEL_ID, [Text.UTF8Encoding]::new($false))
    }
}
if ($env:CONTROL_PLANE_TUNNEL_ID -notmatch '^tunnel_[a-z0-9]{32}$') {
    throw 'The tunnel ID does not match the expected tunnel_... format.'
}

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    $SecureApiKey = Read-Host 'OpenAI runtime API key' -AsSecureString
    $KeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureApiKey)
    try {
        $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($KeyPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($KeyPointer)
    }
}

$BridgeToken = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
$env:SHIRO_AUTH_HEADER = "Bearer $BridgeToken"

Write-Host 'Shiro Secure MCP Tunnel is running. Keep this window open.'
& $TunnelClient run `
    --control-plane.tunnel-id $env:CONTROL_PLANE_TUNNEL_ID `
    --control-plane.api-key 'env:CONTROL_PLANE_API_KEY' `
    --mcp.server-url "url=http://127.0.0.1:$McpPort/mcp,channel=main" `
    --mcp.extra-headers 'Authorization: env:SHIRO_AUTH_HEADER' `
    --mcp.discovery-extra-headers 'Authorization: env:SHIRO_AUTH_HEADER' `
    --mcp.startup-wait-timeout 30s `
    --health.listen-addr '127.0.0.1:0' `
    --health.url-file $HealthUrlFile

exit $LASTEXITCODE
