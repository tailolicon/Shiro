param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$DesktopRoot = Join-Path $RepoRoot 'desktop'
$DistRoot = Join-Path $DesktopRoot 'dist'
$ConfigPath = Join-Path $DesktopRoot 'pake.config.json'
$RuntimeRoot = Join-Path (Split-Path -Parent $RepoRoot) '.ShiroRuntime'
$PakeToolRoot = Join-Path $RuntimeRoot 'PakeTool'
$PakeCommand = Join-Path $PakeToolRoot 'node_modules\.bin\pake.cmd'

if ($Clean -and (Test-Path -LiteralPath $DistRoot)) {
    Remove-Item -LiteralPath $DistRoot -Recurse -Force
}
if (-not (Test-Path -LiteralPath $DistRoot)) {
    New-Item -ItemType Directory -Path $DistRoot | Out-Null
}

$StdoutFile = Join-Path $DistRoot 'pake-result.json'
$StderrFile = Join-Path $DistRoot 'pake-build.log'
$StartedAt = Get-Date
Write-Host 'Building the Shiro Windows app with Pake...'

# Keep Pake in a short path. Building it from pnpm's deep content-addressed
# store can exceed the Windows linker path limit and fail with LNK1104.
if (-not (Test-Path -LiteralPath $PakeCommand -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $PakeToolRoot)) {
        New-Item -ItemType Directory -Path $PakeToolRoot | Out-Null
    }
    $ToolPackage = @{
        name = 'shiro-pake-build-tool'
        private = $true
        dependencies = @{ 'pake-cli' = '3.15.7' }
    } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $PakeToolRoot 'package.json'), $ToolPackage + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Host 'Installing the pinned Pake build tool...'
    Push-Location $PakeToolRoot
    try { & npm install --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $PakeCommand)) {
        throw 'Pake build-tool installation failed.'
    }
}

Push-Location $DesktopRoot
$PreviousErrorAction = $ErrorActionPreference
try {
    # Pake writes harmless package-manager notices to stderr on a successful
    # build; capture them in the build log and decide from its exit code.
    $ErrorActionPreference = 'Continue'
    & $PakeCommand --config $ConfigPath --json 1> $StdoutFile 2> $StderrFile
    $PakeExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $PreviousErrorAction
    Pop-Location
}

if ($PakeExitCode -ne 0) {
    $Detail = if (Test-Path -LiteralPath $StderrFile) { (Get-Content -Tail 80 -LiteralPath $StderrFile) -join [Environment]::NewLine } else { '' }
    throw "Pake build failed.`n$Detail"
}

$RawResult = (Get-Content -Raw -LiteralPath $StdoutFile).Trim()
try { $Result = $RawResult | ConvertFrom-Json } catch { throw "Pake did not return valid JSON. See $StdoutFile" }
if (-not $Result.ok) {
    throw "Pake reported a failed build: $($Result.error.message)"
}

foreach ($Output in @($Result.outputs)) {
    $OutputPath = if ($Output -is [string]) { $Output } elseif ($null -ne $Output.path) { $Output.path } else { $null }
    if ($null -eq $OutputPath -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { continue }
    $Artifact = Get-Item -LiteralPath $OutputPath
    Copy-Item -LiteralPath $Artifact.FullName -Destination (Join-Path $DistRoot $Artifact.Name) -Force
}

$Candidates = Get-ChildItem -LiteralPath $DesktopRoot -Recurse -File | Where-Object {
    $_.LastWriteTime -ge $StartedAt.AddMinutes(-1) -and $_.Extension -in @('.exe', '.msi') -and $_.DirectoryName -ne $DistRoot
}
foreach ($Artifact in $Candidates) {
    $DestinationName = if ($Artifact.Extension -eq '.exe' -and $Artifact.Name -match '^Shiro(?:\.exe)?$') { 'Shiro.exe' } else { $Artifact.Name }
    $Destination = Join-Path $DistRoot $DestinationName
    try {
        Copy-Item -LiteralPath $Artifact.FullName -Destination $Destination -Force
    } catch [System.IO.IOException] {
        if ($DestinationName -ne 'Shiro.exe') { throw }
        $Destination = Join-Path $DistRoot 'Shiro.next.exe'
        Copy-Item -LiteralPath $Artifact.FullName -Destination $Destination -Force
        Write-Host "The running desktop app kept Shiro.exe locked; the verified replacement is at $Destination"
    }
}

$App = Join-Path $DistRoot 'Shiro.exe'
if (-not (Test-Path -LiteralPath $App)) {
    $NewestExe = Get-ChildItem -LiteralPath $DesktopRoot -Recurse -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -ne $NewestExe) { Copy-Item -LiteralPath $NewestExe.FullName -Destination $App -Force }
}

Write-Host "Desktop build complete: $DistRoot"
