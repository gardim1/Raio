# Windows PowerShell 5.1. No administrator, PATH/registry writes or execution-policy changes.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Version,
    [string]$Source,
    [string]$Project,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Raio'),
    [switch]$Uninstall,
    [switch]$RemoveData,
    [switch]$Force,
    # Self-test override, restricted to disposable raio-alpha-shell-* directories under TEMP.
    [string]$DataDir = (Join-Path $env:APPDATA 'io.github.gardim1.raio')
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$versionPattern = '(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?'
$download = $null
$stage = $null
$installLock = $null
$savedTls = [Net.ServicePointManager]::SecurityProtocol

function Full-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An empty path is not allowed.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')) { throw 'A filesystem root is not an install or data directory.' }
    return $full
}
function Assert-PlainPath([string]$Path) {
    $current = $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Refusing a linked directory or file: ' + $current) }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}
function Assert-PlainTree([string]$Path) {
    Assert-PlainPath $Path
    if (Test-Path -LiteralPath $Path -PathType Container) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Refusing a linked directory or file: ' + $child.FullName) }
            if ($child.PSIsContainer) { Assert-PlainTree $child.FullName }
        }
    }
}
function Remove-InstallChild([string]$Path) {
    $full = Full-Path $Path
    if ([IO.Path]::GetDirectoryName($full) -ne $InstallDir -or [IO.Path]::GetFileName($full) -notmatch '\A(?:app|staging-[a-f0-9]{32}|app\.old-[a-f0-9]{32})\z') {
        throw 'Refusing cleanup outside an installer-owned child directory.'
    }
    Assert-PlainTree $full
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}
function Assert-NotRunning {
    $exe = Join-Path $InstallDir 'app\raio.exe'
    foreach ($process in @(Get-Process -Name raio -ErrorAction SilentlyContinue)) {
        if (-not $process.Path) { throw 'Cannot verify the running Raio path. Quit Raio from the tray icon, then run again.' }
        if ([IO.Path]::GetFullPath($process.Path).Equals($exe, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Quit Raio from the tray icon, then run again'
        }
    }
}
function Has-WebView2 {
    # https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
    $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($key in $keys) {
        $item = Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue
        if ($null -ne $item -and -not [string]::IsNullOrWhiteSpace([string]$item.pv) -and $item.pv -ne '0.0.0.0') { return $true }
    }
    return $false
}
function Assert-App([string]$Path) {
    foreach ($name in @('raio.exe', 'raio-hook.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $name) -PathType Leaf)) { throw 'Package must contain both executables: raio.exe and raio-hook.exe.' }
    }
    Assert-PlainTree $Path
}
function Write-Version([string]$Value) {
    $destination = Join-Path $InstallDir 'VERSION.txt'
    Assert-PlainPath $destination
    # app/VERSION.txt travels with the verified payload. Recovery repairs this display copy after
    # interruption, using ordinary writes and renames rather than File.Replace.
    [IO.File]::WriteAllText($destination, $Value + [Environment]::NewLine)
}
function Recover-Install {
    $app = Join-Path $InstallDir 'app'
    $old = @(Get-ChildItem -LiteralPath $InstallDir -Directory -Force | Where-Object Name -Match '\Aapp\.old-[a-f0-9]{32}\z')
    if (-not (Test-Path -LiteralPath $app) -and $old.Count -gt 0) {
        if ($old.Count -ne 1) { throw 'Multiple interrupted installs found; nothing removed. Review InstallDir before retrying.' }
        Assert-App $old[0].FullName
        Move-Item -LiteralPath $old[0].FullName -Destination $app
        Write-Output 'Restored the previous app after an interrupted update.'
    }
    if (Test-Path -LiteralPath $app) {
        Assert-App $app
        $appVersion = Join-Path $app 'VERSION.txt'
        if (Test-Path -LiteralPath $appVersion -PathType Leaf) {
            $value = [IO.File]::ReadAllText($appVersion).Trim()
            if ($value -notmatch ('\A' + $versionPattern + '\z')) { throw 'Invalid installed version; nothing removed.' }
            Write-Version $value
        }
        foreach ($previous in $old) { Remove-InstallChild $previous.FullName }
    }
    foreach ($leftover in @(Get-ChildItem -LiteralPath $InstallDir -Directory -Force | Where-Object Name -Match '\Astaging-[a-f0-9]{32}\z')) {
        Remove-InstallChild $leftover.FullName
    }
}
function Expand-Package([string]$Zip, [string]$Destination, [string]$Name) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $path = $entry.FullName.Replace('\', '/')
            if ($path -eq ($Name + '/')) { continue }
            if (-not $path.StartsWith(($Name + '/'), [StringComparison]::Ordinal) -or $path.Contains(':') -or $path -match '(^|/)\.\.?(/|$)') {
                throw ('Unsafe archive entry: ' + $entry.FullName)
            }
            $relative = $path.Substring($Name.Length + 1)
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            if (-not $target.StartsWith(($Destination + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($target.TrimEnd('\', '/'))) {
                throw ('Unsafe archive entry: ' + $entry.FullName)
            }
        }
        foreach ($entry in $archive.Entries) {
            $path = $entry.FullName.Replace('\', '/')
            if ($path -eq ($Name + '/')) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $path.Substring($Name.Length + 1)))
            if ($path.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null }
            else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            }
        }
    } finally { $archive.Dispose() }
}
function Check-Connections {
    $file = Join-Path $DataDir 'connections.json'
    $unknown = $false
    $connections = @()
    if (Test-Path -LiteralPath $file) {
        try {
            $text = [IO.File]::ReadAllText($file)
            if (-not $text.TrimStart().StartsWith('[')) { throw 'Expected an array.' }
            $parsed = $text | ConvertFrom-Json
            $connections = @($parsed)
            foreach ($connection in $connections) {
                if ($null -eq $connection -or -not $connection.root -or -not $connection.settingsPath) { throw 'Missing connection paths.' }
            }
        } catch { $unknown = $true; $connections = @() }
    } elseif (Test-Path -LiteralPath (Join-Path $DataDir 'raio.db')) {
        # This base persists projects in SQLite; no sqlite dependency is installed by this script.
        $unknown = $true
    }
    if ($connections.Count -gt 0) {
        foreach ($connection in $connections) { Write-Output ('Connected project: ' + $connection.root + ' (' + $connection.settingsPath + ')') }
        if (-not $Force) { throw 'Disconnect these projects in Raio first. Use -Force only to remove the program anyway.' }
    }
    if ($unknown -and -not $Force) { throw 'Cannot establish connected projects. Disconnect these projects in Raio first; use -Force only to remove the program anyway.' }
    if ($Force -and ($unknown -or $connections.Count -gt 0)) { Write-Warning "Removing the program anyway: those projects' hooks would point at a missing program. Integration settings are not removed." }
}

try {
    $InstallDir = Full-Path $InstallDir
    $DataDir = Full-Path $DataDir
    Assert-PlainPath $InstallDir
    Assert-PlainPath $DataDir
    if ($PSBoundParameters.ContainsKey('DataDir')) {
        $tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if (-not $DataDir.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or $DataDir.Substring($tempPrefix.Length) -notmatch '\Araio-alpha-shell-[^\\]+\\') {
            throw '-DataDir is a test override restricted to a disposable raio-alpha-shell-* folder under TEMP.'
        }
    }
    if ($InstallDir -eq $DataDir -or $InstallDir.StartsWith(($DataDir + '\'), [StringComparison]::OrdinalIgnoreCase) -or $DataDir.StartsWith(($InstallDir + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'InstallDir and DataDir must be separate directories.'
    }
    if ($RemoveData -and -not $Uninstall) { throw '-RemoveData requires -Uninstall.' }
    Assert-NotRunning
    if ($Uninstall) {
        Check-Connections
        if (Test-Path -LiteralPath $InstallDir) {
            $installedApp = Join-Path $InstallDir 'app'
            $installedVersion = Join-Path $InstallDir 'VERSION.txt'
            if (-not (Test-Path -LiteralPath $installedVersion -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $installedApp 'raio.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $installedApp 'raio-hook.exe') -PathType Leaf)) {
                throw 'InstallDir is not a recognized Raio installation; nothing removed.'
            }
            Assert-PlainTree $InstallDir
        }
        if ($RemoveData) { Write-Output ('History will also be deleted: ' + $DataDir); Assert-PlainTree $DataDir }
        else { Write-Output ('History is kept: ' + $DataDir) }
        if ($PSCmdlet.ShouldProcess($InstallDir, 'Remove Raio program (integration settings are not changed)')) {
            Assert-NotRunning
            if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
            Write-Output 'Raio program removed. Integration settings were not changed.'
        }
        if ($RemoveData -and $PSCmdlet.ShouldProcess($DataDir, 'Delete Raio history')) {
            if (Test-Path -LiteralPath $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
            Write-Output 'Raio history removed.'
        }
    } else {
        if ($Project) {
            if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw 'Project folder does not exist.' }
            $Project = (Get-Item -LiteralPath $Project).FullName
            Write-Output ('Raio will open the project: ' + $Project)
            Write-Output ('The app shows the hooks it would add to ' + (Join-Path $Project '.claude\settings.local.json') + '; it writes nothing until Connect is clicked.')
        }
        $localZip = $false
        if ($Source -and (Test-Path -LiteralPath $Source -PathType Leaf)) {
            $localZip = $true
            $zipPath = (Get-Item -LiteralPath $Source).FullName
            $match = [regex]::Match([IO.Path]::GetFileName($zipPath), ('\Araio-v(' + $versionPattern + ')-windows-x64\.zip\z'))
            if (-not $match.Success) { throw 'Source zip must be named raio-v<version>-windows-x64.zip.' }
            if (-not $Version) { $Version = $match.Groups[1].Value }
            if ($Version -ne $match.Groups[1].Value) { throw 'Version does not match the source zip.' }
        }
        if (-not $Version -or $Version -notmatch ('\A' + $versionPattern + '\z')) { throw 'Version is required (x.y.z or x.y.z-prerelease), unless Source is a versioned zip.' }
        $name = 'raio-v' + $Version + '-windows-x64'
        $zipName = $name + '.zip'
        $manifestName = 'SHA256SUMS-v' + $Version + '.txt'
        $remote = $false
        if (-not $Source) { $Source = 'https://github.com/gardim1/Raio/releases/download/v' + $Version + '/' }
        if ($localZip) { $sourceFolder = [IO.Path]::GetDirectoryName($zipPath) }
        elseif (Test-Path -LiteralPath $Source -PathType Container) {
            $sourceFolder = (Get-Item -LiteralPath $Source).FullName
            $zipPath = Join-Path $sourceFolder $zipName
        } else {
            $uri = $null
            $prefix = 'https://github.com/gardim1/Raio/releases/download/'
            if (-not [uri]::TryCreate($Source, [UriKind]::Absolute, [ref]$uri) -or -not $Source.StartsWith($prefix, [StringComparison]::Ordinal) -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or -not $uri.AbsoluteUri.StartsWith($prefix, [StringComparison]::Ordinal)) {
                throw ('Only ' + $prefix + ' URL bases are accepted. Local Source must be an existing folder or zip.')
            }
            $Source = $uri.AbsoluteUri.TrimEnd('/') + '/'
            $remote = $true
        }
        if (-not (Has-WebView2)) { Write-Warning 'Microsoft WebView2 Runtime is missing. Download it from https://developer.microsoft.com/microsoft-edge/webview2/ ; this script does not install it.' }
        Write-Output 'SHA256 checks integrity against the manifest from the same origin; it is not a signature.'
        if ($PSCmdlet.ShouldProcess($InstallDir, ('Verify and install Raio ' + $Version))) {
            $download = Join-Path $env:TEMP ('raio-alpha-shell-download-' + [guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($download) | Out-Null
            $verifiedZip = Join-Path $download $zipName
            $manifest = Join-Path $download $manifestName
            if ($remote) {
                [Net.ServicePointManager]::SecurityProtocol = $savedTls -bor [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri ($Source + $manifestName) -OutFile $manifest -UseBasicParsing -ErrorAction Stop
                Invoke-WebRequest -Uri ($Source + $zipName) -OutFile $verifiedZip -UseBasicParsing -ErrorAction Stop
            } else {
                Copy-Item -LiteralPath (Join-Path $sourceFolder $manifestName) -Destination $manifest
                Copy-Item -LiteralPath $zipPath -Destination $verifiedZip
            }
            $entries = @([IO.File]::ReadAllLines($manifest) | Where-Object { $_ -cmatch ('\A([a-fA-F0-9]{64})  ' + [regex]::Escape($zipName) + '\z') })
            if ($entries.Count -ne 1) { throw 'Missing or duplicate SHA256 manifest entry for the zip.' }
            $expected = $entries[0].Substring(0, 64)
            if ((Get-FileHash -LiteralPath $verifiedZip -Algorithm SHA256).Hash -ne $expected) { throw 'SHA256 mismatch; nothing installed.' }
            Assert-NotRunning
            if (Test-Path -LiteralPath $InstallDir) {
                foreach ($item in Get-ChildItem -LiteralPath $InstallDir -Force) {
                    if ($item.Name -notmatch '\A(?:app|VERSION\.txt|\.install\.lock|staging-[a-f0-9]{32}|app\.old-[a-f0-9]{32})\z') { throw 'InstallDir contains unrelated files; use a dedicated Raio directory.' }
                }
                Assert-PlainTree $InstallDir
            }
            [IO.Directory]::CreateDirectory($InstallDir) | Out-Null
            try { $installLock = [IO.File]::Open((Join-Path $InstallDir '.install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch { throw 'Another install is using InstallDir. Wait for it to finish, then run again.' }
            Recover-Install
            $stage = Join-Path $InstallDir ('staging-' + [guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($stage) | Out-Null
            Expand-Package $verifiedZip $stage $name
            Assert-App $stage
            [IO.File]::WriteAllText((Join-Path $stage 'VERSION.txt'), $Version + [Environment]::NewLine)
            Assert-NotRunning
            $app = Join-Path $InstallDir 'app'
            $previous = $null
            $promoted = $false
            try {
                if (Test-Path -LiteralPath $app) {
                    $previous = Join-Path $InstallDir ('app.old-' + [guid]::NewGuid().ToString('N'))
                    Move-Item -LiteralPath $app -Destination $previous
                }
                Move-Item -LiteralPath $stage -Destination $app
                $stage = $null
                $promoted = $true
                Write-Version $Version
            } catch {
                if ($promoted) { Remove-InstallChild $app }
                if ($previous -and (Test-Path -LiteralPath $previous)) {
                    Move-Item -LiteralPath $previous -Destination $app
                    Write-Version ([IO.File]::ReadAllText((Join-Path $app 'VERSION.txt')).Trim())
                }
                throw
            }
            if ($previous) { Remove-InstallChild $previous }
            Write-Output ('Installed Raio ' + $Version + ' at ' + $app + '. Hooks keep this stable path across updates.')
        }
        if ($Project -and $PSCmdlet.ShouldProcess($Project, 'Open Raio Connect preview')) {
            # Start-Process joins ArgumentList on Windows PowerShell 5.1. Quote the whole path and
            # double trailing backslashes so a drive-root argument cannot escape the closing quote.
            $projectArgument = '"' + ($Project -replace '(\\+)\z', '$1$1') + '"'
            Start-Process -FilePath (Join-Path $InstallDir 'app\raio.exe') -ArgumentList @('--project', $projectArgument) -WindowStyle Hidden
        }
    }
} catch {
    Write-Output ('Raio installer failed: ' + $_.Exception.Message)
    exit 1
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-InstallChild $stage }
    if ($null -ne $installLock) { $installLock.Dispose() }
    if ($download -and (Test-Path -LiteralPath $download)) {
        $tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        $download = Full-Path $download
        if (-not $download.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($download) -notmatch '\Araio-alpha-shell-download-[a-f0-9]{32}\z') { throw 'Refusing cleanup outside the download temp directory.' }
        Assert-PlainTree $download
        Remove-Item -LiteralPath $download -Recurse -Force
    }
}
exit 0
