param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$Docker = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $Docker) { throw 'Docker Desktop is required for Shiro sandbox_exec.' }

function Test-DockerReady {
    # Probe through cmd.exe so a stopped Docker daemon's stderr never reaches
    # PowerShell: under $ErrorActionPreference = 'Stop', Windows PowerShell 5.1
    # turns redirected native stderr into a terminating NativeCommandError,
    # which would abort the script here instead of letting the caller start
    # Docker Desktop and retry.
    & cmd.exe /d /c "`"$($Docker.Source)`" info --format `"{{.ServerVersion}}`" 1>nul 2>nul"
    return $LASTEXITCODE -eq 0
}

if (-not (Test-DockerReady)) {
    $Candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
    )
    $Desktop = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($null -eq $Desktop) { throw 'Docker Desktop is installed but its launcher was not found.' }
    Start-Process -FilePath $Desktop -WindowStyle Hidden | Out-Null
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        Start-Sleep -Seconds 2
        if (Test-DockerReady) { break }
    }
    if (-not (Test-DockerReady)) { throw 'Docker Desktop did not become ready within two minutes.' }
}

$Image = 'shiro-runner:0.1.0'
& $Docker.Source build --quiet --tag $Image --file (Join-Path $RepoRoot 'container\Dockerfile') (Join-Path $RepoRoot 'container') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to build the Shiro isolated runner image.' }

foreach ($Volume in @('shiro-root-node-modules', 'shiro-bridge-node-modules', 'shiro-pnpm-store')) {
    & $Docker.Source volume create $Volume | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to prepare Docker volume $Volume." }
}

$Mounts = @(
    '--mount', "type=bind,source=$RepoRoot,target=/workspace",
    '--mount', 'type=volume,source=shiro-root-node-modules,target=/workspace/node_modules',
    '--mount', 'type=volume,source=shiro-bridge-node-modules,target=/workspace/bridge/node_modules',
    '--mount', 'type=volume,source=shiro-pnpm-store,target=/pnpm/store'
)
& $Docker.Source run --rm --network none @Mounts --workdir /workspace $Image 'test -f bridge/node_modules/@modelcontextprotocol/sdk/package.json'
if ($LASTEXITCODE -ne 0) {
    & $Docker.Source run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges `
        --pids-limit 512 --memory 4g --cpus 4 @Mounts --workdir /workspace --env CI=true $Image `
        'pnpm --dir bridge install --frozen-lockfile=false --config.auto-install-peers=false --store-dir /pnpm/store'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare Shiro runner dependencies.' }
}

Write-Host 'Shiro isolated runner is ready.'
