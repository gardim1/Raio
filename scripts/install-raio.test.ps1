# Disposable Windows PowerShell 5.1 self-test. No real executables, installs, registry writes or GUI.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install-raio.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer not implemented yet.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$testRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP ('raio-alpha-shell-inst-' + [guid]::NewGuid().ToString('N') + ' caf' + [char]0xE9)))
$install = Join-Path $testRoot 'Program files Raio'
$data = Join-Path $testRoot 'History Raio'
$source = Join-Path $testRoot 'Release files'
$script:checks = 0
$raioTestBoundary = @{ RunningPath = $null; DownloadMode = 'copy'; Source = $source; FailPromotion = $false; Runtime = 'missing'; Keys = @(); Launch = $null }
function Assert-That($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Run-Installer([hashtable]$Arguments, [int]$ExpectedCode = 0, [string]$Message = '') {
    $Arguments.InstallDir = $install
    $Arguments.DataDir = $data
    $global:LASTEXITCODE = 0
    $output = (& $installer @Arguments *>&1 | Out-String)
    Assert-That ($LASTEXITCODE -eq $ExpectedCode) ('Unexpected installer exit: ' + $LASTEXITCODE + '; ' + $output)
    if ($Message) { Assert-That ($output.Contains($Message)) ('Missing message: ' + $Message + '; ' + $output) }
    return $output
}
# Only the installer boundaries are injected: real verification/extraction/recovery/uninstall run below.
function Get-Process {
    param($Name, $ErrorAction)
    if ($raioTestBoundary.RunningPath) { [pscustomobject]@{ Path = $raioTestBoundary.RunningPath } }
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $ErrorAction)
    if ($raioTestBoundary.DownloadMode -eq 'interrupt') {
        [IO.File]::WriteAllText($OutFile, 'partial download')
        throw 'Simulated interrupted download'
    }
    Copy-Item -LiteralPath (Join-Path $raioTestBoundary.Source ([IO.Path]::GetFileName(([uri]$Uri).AbsolutePath))) -Destination $OutFile
}
function Get-ItemProperty {
    param($LiteralPath, $Name, $ErrorAction)
    $raioTestBoundary.Keys += $LiteralPath
    if ($raioTestBoundary.Runtime -eq 'current-user') {
        if ($LiteralPath.StartsWith('HKLM:')) { [pscustomobject]@{ pv = '0.0.0.0' } }
        else { [pscustomobject]@{ pv = '123.0.0.1' } }
    }
}
function Move-Item {
    param($LiteralPath, $Destination)
    if ($raioTestBoundary.FailPromotion -and [IO.Path]::GetFileName($LiteralPath) -like 'staging-*' -and [IO.Path]::GetFileName($Destination) -eq 'app') {
        $raioTestBoundary.FailPromotion = $false
        throw 'Simulated failed staging rename'
    }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle)
    $raioTestBoundary.Launch = @{ FilePath = $FilePath; Arguments = $ArgumentList; WindowStyle = $WindowStyle }
}
function New-Package([string]$Version, [string]$Content, [switch]$MissingHook, [switch]$Traversal) {
    $build = Join-Path $testRoot ('fixture-' + [guid]::NewGuid().ToString('N'))
    $name = 'raio-v' + $Version + '-windows-x64'
    $payload = Join-Path $build $name
    [IO.Directory]::CreateDirectory($payload) | Out-Null
    [IO.File]::WriteAllText((Join-Path $payload 'raio.exe'), $Content)
    if (-not $MissingHook) { [IO.File]::WriteAllText((Join-Path $payload 'raio-hook.exe'), 'fake hook ' + $Content) }
    $zip = Join-Path $source ($name + '.zip')
    [IO.Compression.ZipFile]::CreateFromDirectory($build, $zip)
    if ($Traversal) {
        $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Update)
        try {
            $entry = $archive.CreateEntry('../outside.txt')
            $writer = New-Object IO.StreamWriter($entry.Open())
            try { $writer.Write('must not escape staging') } finally { $writer.Dispose() }
        } finally { $archive.Dispose() }
    }
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $source ('SHA256SUMS-v' + $Version + '.txt')), $hash + '  ' + $name + ".zip`n")
    return $zip
}
try {
    [IO.Directory]::CreateDirectory($source) | Out-Null
    [IO.Directory]::CreateDirectory($data) | Out-Null
    [IO.File]::WriteAllText((Join-Path $data 'history.txt'), 'keep history')
    $neighbor = Join-Path $testRoot 'Other data'
    [IO.Directory]::CreateDirectory($neighbor) | Out-Null
    [IO.File]::WriteAllText((Join-Path $neighbor 'keep.txt'), 'keep neighbor')
    $zip = New-Package '0.1.0-alpha.1' 'first install'
    $null = Run-Installer @{ Source = $zip; WhatIf = $true }
    Assert-That (-not (Test-Path -LiteralPath $install)) 'WhatIf created an install directory.'
    $null = Run-Installer @{ Source = $zip } 0 'https://developer.microsoft.com/microsoft-edge/webview2/'
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'app/raio.exe')) -eq 'first install') 'Install payload differs.'
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'VERSION.txt')).Trim() -eq '0.1.0-alpha.1') 'Version was not recorded.'
    # Verify only the exact zip entry, ignoring script and similar-name entries.
    $firstManifest = Join-Path $source 'SHA256SUMS-v0.1.0-alpha.1.txt'
    $zipEntry = [IO.File]::ReadAllText($firstManifest)
    [IO.File]::WriteAllText($firstManifest, ('b' * 64) + "  install-raio.ps1`n" + ('c' * 64) + '  ' + [IO.Path]::GetFileName($zip) + ".backup`n" + $zipEntry)
    $null = Run-Installer @{ Source = $zip }
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'app/raio.exe')) -eq 'first install') 'Extra manifest entries prevented an exact-name zip install.'
    Assert-That (Test-Path -LiteralPath (Join-Path $data 'history.txt')) 'Reinstall deleted history.'
    $update = New-Package '0.1.0-alpha.2' 'updated install'
    $raioTestBoundary.FailPromotion = $true
    $null = Run-Installer @{ Source = $update } 1 'Simulated failed staging rename'
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'app/raio.exe')) -eq 'first install') 'Failed promotion did not restore the previous app.'
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'VERSION.txt')).Trim() -eq '0.1.0-alpha.1') 'Failed promotion changed the installed version.'
    $null = Run-Installer @{ Version = '0.1.0-alpha.2'; Source = $source }
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'app/raio.exe')) -eq 'updated install') 'Update did not replace the app.'
    Assert-That (@(Get-ChildItem -LiteralPath $install -Directory | Where-Object Name -Like 'app.old-*').Count -eq 0) 'Old app not cleaned.'
    [IO.File]::AppendAllText($update, 'tampered')
    $null = Run-Installer @{ Source = $update } 1 'SHA256 mismatch'
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'app/raio.exe')) -eq 'updated install') 'Tampered update damaged installed app.'
    $missing = New-Package '0.1.0-alpha.3' 'missing entry'
    [IO.File]::WriteAllText((Join-Path $source 'SHA256SUMS-v0.1.0-alpha.3.txt'), ('a' * 64) + "  other.zip`n")
    $null = Run-Installer @{ Source = $missing } 1 'manifest entry'
    $scriptOnly = New-Package '0.1.0-alpha.8' 'script and near-name entries only'
    $scriptOnlyHash = (Get-FileHash -LiteralPath $scriptOnly -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $source 'SHA256SUMS-v0.1.0-alpha.8.txt'), $scriptOnlyHash + "  install-raio.ps1`n" + $scriptOnlyHash + '  ' + [IO.Path]::GetFileName($scriptOnly) + ".backup`n")
    $null = Run-Installer @{ Source = $scriptOnly } 1 'manifest entry'
    $missingManifest = New-Package '0.1.0-alpha.6' 'missing manifest'
    Remove-Item -LiteralPath (Join-Path $source 'SHA256SUMS-v0.1.0-alpha.6.txt')
    $null = Run-Installer @{ Source = $missingManifest } 1
    $duplicate = New-Package '0.1.0-alpha.7' 'duplicate manifest'
    $duplicateManifest = Join-Path $source 'SHA256SUMS-v0.1.0-alpha.7.txt'
    [IO.File]::AppendAllText($duplicateManifest, [IO.File]::ReadAllText($duplicateManifest))
    $null = Run-Installer @{ Source = $duplicate } 1 'duplicate SHA256 manifest entry'
    $incomplete = New-Package '0.1.0-alpha.4' 'missing hook' -MissingHook
    $null = Run-Installer @{ Source = $incomplete } 1 'both executables'
    $unsafe = New-Package '0.1.0-alpha.5' 'unsafe zip' -Traversal
    $null = Run-Installer @{ Source = $unsafe } 1 'Unsafe archive entry'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $testRoot 'outside.txt'))) 'Archive escaped staging.'
    $null = Run-Installer @{ Version = '0.1.0-alpha.1'; Source = 'https://example.com/' } 1 'Only https://github.com/gardim1/Raio/releases/download/'
    $null = Run-Installer @{ Version = '0.1.0-alpha.1'; Source = 'https://github.com.evil.example/gardim1/Raio/releases/download/' } 1 'Only https://github.com/gardim1/Raio/releases/download/'
    $raioTestBoundary.DownloadMode = 'interrupt'
    $null = Run-Installer @{ Version = '0.1.0-alpha.1'; WhatIf = $true }
    $tempBefore = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'raio-alpha-shell-download-*' | ForEach-Object FullName)
    $null = Run-Installer @{ Version = '0.1.0-alpha.1' } 1 'Simulated interrupted download'
    $tempAfter = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'raio-alpha-shell-download-*' | ForEach-Object FullName)
    Assert-That (($tempAfter -join '|') -eq ($tempBefore -join '|')) 'Interrupted download left temp files.'
    $raioTestBoundary.DownloadMode = 'copy'
    $null = Run-Installer @{ Version = '0.1.0-alpha.1' }
    # Simulate interruption after the old-app rename, before the staging rename.
    $old = Join-Path $install ('app.old-' + ('a' * 32))
    Move-Item -LiteralPath (Join-Path $install 'app') -Destination $old
    $stale = Join-Path $install ('staging-' + ('b' * 32))
    [IO.Directory]::CreateDirectory($stale) | Out-Null
    [IO.File]::WriteAllText((Join-Path $stale 'partial.txt'), 'interrupted')
    $null = Run-Installer @{ Source = $zip }
    Assert-That (Test-Path -LiteralPath (Join-Path $install 'app/raio-hook.exe')) 'Interrupted swap was not recovered.'
    Assert-That (-not (Test-Path -LiteralPath $stale)) 'Stale staging was not removed.'
    # A crash after promotion can leave stale display metadata; the staged version repairs it.
    [IO.File]::WriteAllText((Join-Path $install 'VERSION.txt'), 'partial metadata')
    $null = Run-Installer @{ Source = $incomplete } 1 'both executables'
    Assert-That ([IO.File]::ReadAllText((Join-Path $install 'VERSION.txt')).Trim() -eq '0.1.0-alpha.1') 'Recovery did not repair version metadata.'
    $lockPath = Join-Path $install '.install.lock'
    $heldLock = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $null = Run-Installer @{ Source = $zip } 1 'Another install is using InstallDir' }
    finally { $heldLock.Dispose() }
    $raioTestBoundary.RunningPath = Join-Path $install 'app/raio.exe'
    $null = Run-Installer @{ Source = $zip } 1 'Quit Raio from the tray icon, then run again'
    $null = Run-Installer @{ Uninstall = $true } 1 'Quit Raio from the tray icon, then run again'
    $raioTestBoundary.RunningPath = $null
    $project = Join-Path $testRoot ('Project caf' + [char]0xE9 + ' with spaces')
    [IO.Directory]::CreateDirectory($project) | Out-Null
    $null = Run-Installer @{ Source = $zip; Project = $project; WhatIf = $true } 0 'writes nothing until Connect is clicked'
    Assert-That ($null -eq $raioTestBoundary.Launch) 'WhatIf launched an app.'
    $null = Run-Installer @{ Source = $zip; Project = $project }
    Assert-That ($raioTestBoundary.Launch.FilePath -eq (Join-Path $install 'app/raio.exe')) 'Project launch used the wrong executable.'
    Assert-That ($raioTestBoundary.Launch.Arguments.Count -eq 2 -and $raioTestBoundary.Launch.Arguments[0] -eq '--project' -and $raioTestBoundary.Launch.Arguments[1] -eq ('"' + $project + '"')) 'Project path was not preserved as a quoted argument.'
    Assert-That ($raioTestBoundary.Launch.WindowStyle -eq 'Hidden') 'The launcher created a visible helper window.'
    $null = Run-Installer @{ Source = $zip; Project = (Join-Path $testRoot 'absent') } 1 'Project folder'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $project '.claude'))) 'Installer touched project settings.'
    $raioTestBoundary.Runtime = 'current-user'
    $raioTestBoundary.Keys = @()
    $runtimeOutput = Run-Installer @{ Source = $zip; WhatIf = $true }
    Assert-That (-not $runtimeOutput.Contains('WebView2 Runtime is missing')) 'Valid per-user WebView2 runtime was missed.'
    Assert-That ($raioTestBoundary.Keys.Count -eq 2 -and $raioTestBoundary.Keys[0] -eq 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -and $raioTestBoundary.Keys[1] -eq 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') 'WebView2 detection used the wrong registry keys.'
    [IO.File]::WriteAllText((Join-Path $data 'raio.db'), 'synthetic database')
    $null = Run-Installer @{ Uninstall = $true } 1 'Cannot establish connected projects'
    $null = Run-Installer @{ Uninstall = $true; Force = $true; WhatIf = $true } 0 'hooks would point at a missing program'
    Remove-Item -LiteralPath (Join-Path $data 'raio.db')
    [IO.File]::WriteAllText((Join-Path $data 'connections.json'), '[{"root":"synthetic project","settingsPath":"synthetic settings"}]')
    $null = Run-Installer @{ Uninstall = $true } 1 'Disconnect these projects in Raio first'
    Assert-That (Test-Path -LiteralPath (Join-Path $install 'app/raio.exe')) 'Connected uninstall removed program.'
    $null = Run-Installer @{ Uninstall = $true; Force = $true } 0 'hooks would point at a missing program'
    Assert-That (-not (Test-Path -LiteralPath $install)) 'Forced uninstall did not remove program.'
    Assert-That (Test-Path -LiteralPath (Join-Path $data 'history.txt')) 'Uninstall removed history without RemoveData.'
    $stable = New-Package '0.1.0' 'stable version'
    $null = Run-Installer @{ Source = $stable }
    [IO.File]::WriteAllText((Join-Path $data 'connections.json'), 'not json')
    $null = Run-Installer @{ Uninstall = $true } 1 'Cannot establish connected projects'
    [IO.File]::WriteAllText((Join-Path $data 'connections.json'), '[]')
    # A pending connection change makes even a syntactically valid manifest stale.
    $pending = Join-Path $data 'connections.pending'
    [IO.File]::WriteAllText($pending, '')
    foreach ($manifest in @('[]', '[{"root":"stale project","settingsPath":"stale settings"}]', $null)) {
        if ($null -eq $manifest) { Remove-Item -LiteralPath (Join-Path $data 'connections.json') }
        else { [IO.File]::WriteAllText((Join-Path $data 'connections.json'), $manifest) }
        $pendingOutput = Run-Installer @{ Uninstall = $true } 1 'Cannot establish connected projects'
        Assert-That (-not $pendingOutput.Contains('Connected project:')) 'Pending manifest listed unverified projects.'
        Assert-That (Test-Path -LiteralPath (Join-Path $install 'app/raio.exe')) 'Pending manifest allowed unforced removal.'
        $forcedOutput = Run-Installer @{ Uninstall = $true; Force = $true; WhatIf = $true } 0 'hooks would point at a missing program'
        Assert-That (-not $forcedOutput.Contains('Connected project:')) 'Forced pending manifest listed unverified projects.'
        Assert-That (Test-Path -LiteralPath $pending) 'Installer cleared the core-owned pending marker.'
    }
    Remove-Item -LiteralPath $pending
    [IO.File]::WriteAllText((Join-Path $data 'connections.json'), '[]')
    $null = Run-Installer @{ Uninstall = $true; RemoveData = $true; WhatIf = $true }
    Assert-That (Test-Path -LiteralPath $install) 'WhatIf uninstall removed program.'
    Assert-That (Test-Path -LiteralPath $data) 'WhatIf uninstall removed history.'
    $null = Run-Installer @{ Uninstall = $true; RemoveData = $true }
    Assert-That (-not (Test-Path -LiteralPath $install)) 'Uninstall with empty connections did not remove program.'
    Assert-That (-not (Test-Path -LiteralPath $data)) 'RemoveData did not remove the explicit data directory.'
    Assert-That (Test-Path -LiteralPath (Join-Path $neighbor 'keep.txt')) 'RemoveData touched a neighboring directory.'
    $null = Run-Installer @{ Source = $zip }
    $null = Run-Installer @{ Uninstall = $true }
    Assert-That (-not (Test-Path -LiteralPath $install)) 'Uninstall without connections.json failed.'
    [IO.Directory]::CreateDirectory($install) | Out-Null
    [IO.File]::WriteAllText((Join-Path $install 'VERSION.txt'), '0.1.0')
    [IO.File]::WriteAllText((Join-Path $install 'keep.txt'), 'not an app')
    $null = Run-Installer @{ Uninstall = $true } 1 'not a recognized Raio installation'
    Assert-That (Test-Path -LiteralPath (Join-Path $install 'keep.txt')) 'Uninstall removed a directory that was not a Raio install.'
    Write-Output ('PASS: ' + $script:checks + ' assertions; fake executables only; all data under ' + $testRoot)
} catch {
    Write-Output ('FAIL: ' + $_.Exception.Message)
    exit 1
} finally {
    $tempBoundary = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $testRoot.StartsWith($tempBoundary, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($testRoot) -notlike 'raio-alpha-shell-inst-*') {
        throw 'Refusing to clean a path outside the disposable test directory.'
    }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
exit 0
