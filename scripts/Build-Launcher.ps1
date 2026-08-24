$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $Csc -PathType Leaf)) {
    $Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $Csc -PathType Leaf)) {
    throw 'The .NET Framework C# compiler (csc.exe) was not found; it ships with Windows under \Windows\Microsoft.NET.'
}

$Source = Join-Path $RepoRoot 'desktop\launcher\ShiroLauncher.cs'
$Output = Join-Path $RepoRoot 'Shiro.exe'
& $Csc /nologo /target:winexe /optimize+ "/out:$Output" /r:System.Windows.Forms.dll $Source
if ($LASTEXITCODE -ne 0) { throw 'Shiro launcher build failed.' }
Write-Host "Shiro launcher built: $Output"
