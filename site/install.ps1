# Jori installer for Windows - https://getjori.ai/install.ps1
#
#   JoriSetup.exe (apps/windows) runs this, or in PowerShell:
#   irm https://getjori.ai/install.ps1 | iex
#
# Jori's host is Linux-shaped (Node.js, bash, cron, a systemd service), so on
# Windows it runs inside WSL 2, in a distro of its own named "Jori":
#   1. turns on WSL if it is off (asks for administrator approval once; a
#      restart may be needed, after which this resumes by itself);
#   2. downloads Ubuntu 24.04's WSL image (checksum-verified) and imports it
#      as the "Jori" distro, with systemd on and a user named after you;
#   3. runs the normal installer (site/install.sh) inside it;
#   4. adds a Startup item that keeps the distro running (Windows stops a WSL
#      distro once nothing holds it open), Start-menu shortcuts, and opens the
#      setup page in your browser.
# Re-running it updates Jori and reopens setup; nothing done is redone.
#
# Environment:
#   JORI_DISTRO        the WSL distro name (default Jori)
#   JORI_INSTALLER_URL where install.sh comes from (default https://getjori.ai/install.sh)
#   JORI_NO_SETUP=1    install only; open "Jori setup" from the Start menu later

# Continue, not Stop: under Windows PowerShell 5.1 a native command's stderr
# (wsl.exe, 2>&1) would otherwise throw. Failures are checked explicitly.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Distro    = if ($env:JORI_DISTRO) { $env:JORI_DISTRO } else { 'Jori' }
$Installer = if ($env:JORI_INSTALLER_URL) { $env:JORI_INSTALLER_URL } else { 'https://getjori.ai/install.sh' }
$Root      = Join-Path $env:LOCALAPPDATA 'Jori'
$DistroDir = Join-Path $Root 'wsl'
$Self      = Join-Path $Root 'install.ps1'
$ImageBase = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current'

function Step($m) { Write-Host ''; Write-Host "> $m" -ForegroundColor White }
function Ok($m)   { Write-Host "  + $m" -ForegroundColor Green }
function Note($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Die($m)  { Write-Host ''; Write-Host "  x $m" -ForegroundColor Red; Write-Host ''; Read-Host 'Press Enter to close'; exit 1 }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
# Keep a copy so the post-restart resume and the Start-menu "Repair" can run it.
if ($PSCommandPath -and (Test-Path $PSCommandPath) -and ($PSCommandPath -ne $Self)) { Copy-Item $PSCommandPath $Self -Force }
elseif (-not (Test-Path $Self)) { try { Invoke-WebRequest 'https://getjori.ai/install.ps1' -UseBasicParsing -OutFile $Self } catch {} }

Write-Host ''
Write-Host 'Installing Jori' -ForegroundColor White

# -- Windows version --------------------------------------------------------
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19041) { Die "Jori needs Windows 10 version 2004 or newer, or Windows 11 (this is build $build). Update Windows, then run this again." }

# wsl.exe writes UTF-16; read its output as text either way.
function Wsl([string[]]$a) {
  $prev = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.Encoding]::Unicode
  try { $out = & wsl.exe @a 2>&1 | Out-String } finally { [Console]::OutputEncoding = $prev }
  return @{ Code = $LASTEXITCODE; Out = ($out -replace "`0", '') }
}

# -- WSL --------------------------------------------------------------------
Step 'Windows Subsystem for Linux'
$wslOk = $false
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  $st = Wsl @('--status')
  $wslOk = ($st.Code -eq 0)
}
function Request-Restart {
  # Resume after the restart, once.
  $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Self`""
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'JoriSetup' -Value $cmd -Force | Out-Null
  Write-Host ''
  Write-Host '  WSL is on. Windows needs to restart to finish turning it on.' -ForegroundColor Yellow
  Write-Host '  After the restart and sign-in, the Jori install continues by itself.' -ForegroundColor Yellow
  $a = Read-Host '  Restart now? (Y/n)'
  if ($a -notmatch '^[nN]') { Restart-Computer -Force }
  exit 0
}
if (-not $wslOk) {
  Note 'Turning on WSL. Windows asks for administrator approval once.'
  try { Start-Process wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -ErrorAction Stop | Out-Null }
  catch { Die 'WSL needs administrator approval to turn on. Run JoriSetup.exe again and choose Yes when Windows asks.' }
  $st = Wsl @('--status')
  if ($st.Code -ne 0) { Request-Restart }
}
& wsl.exe --set-default-version 2 2>$null | Out-Null
Ok 'ready'

# -- the Jori distro --------------------------------------------------------
Step 'Linux for Jori (Ubuntu 24.04)'
$list = (Wsl @('--list','--quiet')).Out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($list -contains $Distro) {
  Ok "already set up ($Distro)"
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  $file = "ubuntu-noble-wsl-$arch-wsl.rootfs.tar.gz"
  $tmp  = Join-Path $env:TEMP $file
  Note 'Downloading Ubuntu (about 350 MB)...'
  try {
    $sums = (Invoke-WebRequest "$ImageBase/SHA256SUMS" -UseBasicParsing).Content
    Invoke-WebRequest "$ImageBase/$file" -UseBasicParsing -OutFile $tmp
  } catch { Die "Couldn't download Ubuntu: $($_.Exception.Message)" }
  $want = ($sums -split "`n" | Where-Object { $_ -match "\s\*?$([regex]::Escape($file))$" } | Select-Object -First 1) -replace '\s.*$', ''
  $got  = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $got) { Remove-Item $tmp -Force; Die 'The Ubuntu download did not match its published checksum; nothing was installed.' }
  New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
  $r = Wsl @('--import', $Distro, $DistroDir, $tmp, '--version', '2')
  Remove-Item $tmp -Force
  if ($r.Code -ne 0) {
    if ($r.Out -match '0x80370102|BIOS|virtuali[sz]ation') { Die "WSL needs virtualization, which is off in this PC's firmware (BIOS/UEFI). Turn on Intel VT-x / AMD-V (often called Virtualization Technology or SVM), then run JoriSetup.exe again." }
    if ($r.Out -match 'restart|reboot|0x8007019e|0x800701bc') { Request-Restart }
    Die "WSL couldn't import Ubuntu: $($r.Out.Trim())"
  }
  Ok "imported as $Distro"
}

# A Linux user named after the Windows one: lowercase letters, digits, - and _.
$user = ($env:USERNAME.ToLower() -replace '[^a-z0-9_-]', '')
if (-not $user -or $user -notmatch '^[a-z_]') { $user = "jori$user" }
if ($user.Length -gt 30) { $user = $user.Substring(0, 30) }

# Root-side preparation: the user, passwordless sudo (setup's own steps use
# sudo and nobody types a Linux password here), systemd, base packages.
$prep = @"
set -e
id -u $user >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo $user
echo '$user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-jori && chmod 440 /etc/sudoers.d/90-jori
cat > /etc/wsl.conf <<'EOF'
# Written by the Jori installer for Windows (site/install.ps1).
[boot]
systemd=true
[user]
default=$user
[interop]
appendWindowsPath=true
EOF
if ! command -v git >/dev/null || ! command -v crontab >/dev/null || ! command -v xz >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq git curl ca-certificates cron xz-utils >/dev/null
fi
"@
Step 'Preparing it'
& wsl.exe -d $Distro -u root --exec bash -c ($prep -replace "`r", '')
if ($LASTEXITCODE -ne 0) { Die 'Preparing Linux failed; the lines above say why. Run JoriSetup.exe again to retry.' }
# Restart the distro so systemd and the default user take effect.
& wsl.exe --terminate $Distro 2>$null | Out-Null
Ok "user $user, systemd on"

# -- Jori itself ------------------------------------------------------------
Step 'Jori'
Note 'Installing Node.js, Claude Code, memory search and Jori (a few minutes)...'
$inner = "curl -fsSL '$Installer' -o /tmp/jori-install.sh && JORI_NO_SETUP=1 bash /tmp/jori-install.sh; s=`$?; rm -f /tmp/jori-install.sh; exit `$s"
& wsl.exe -d $Distro -u $user --cd '~' --exec bash -lc $inner
if ($LASTEXITCODE -ne 0) { Die 'The Jori install stopped before it finished. The lines above say why; run JoriSetup.exe again to retry.' }

# -- keep it running --------------------------------------------------------
Step 'Keeping Jori running'
# A hidden, long-lived wsl.exe holds the distro open; started at every sign-in.
$vbs = Join-Path $Root 'keep-running.vbs'
@"
' Keeps the Jori WSL distro running (site/install.ps1).
CreateObject("WScript.Shell").Run "wsl.exe -d $Distro --exec /bin/sleep infinity", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII
# In the Startup folder, which needs no administrator rights (a logon
# scheduled task would).
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Jori.lnk'
$ks = (New-Object -ComObject WScript.Shell).CreateShortcut($startup)
$ks.TargetPath = 'wscript.exe'; $ks.Arguments = "`"$vbs`""; $ks.Description = 'Keeps Jori running in WSL'
$ks.Save()
Start-Process wscript.exe -ArgumentList "`"$vbs`"" | Out-Null
Ok 'starts when you sign in to Windows'

# -- shortcuts --------------------------------------------------------------
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Jori'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
$sh = New-Object -ComObject WScript.Shell
$icon = Join-Path $Root 'jori.ico'
function Link($name, $target, $arguments) {
  $l = $sh.CreateShortcut((Join-Path $menu "$name.lnk"))
  $l.TargetPath = $target; $l.Arguments = $arguments
  if (Test-Path $icon) { $l.IconLocation = $icon }
  $l.Save()
}
Link 'Jori setup' 'wsl.exe' "-d $Distro --cd ~ --exec bash -lc `"jori setup`""
Link 'Jori control room' 'explorer.exe' 'http://localhost:9096/control'
Link 'Update Jori' 'wsl.exe' "-d $Distro --cd ~ --exec bash -lc `"jori update; read -p 'Done. Press Enter to close.'`""
Link 'Repair Jori' 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$Self`""
Ok 'Start menu: Jori'

if ($env:JORI_NO_SETUP -eq '1') { Write-Host ''; Write-Host 'Installed. Open "Jori setup" from the Start menu to finish.' -ForegroundColor White; exit 0 }

# -- setup ------------------------------------------------------------------
Step 'Setup'
Note 'Opening the setup page in your browser. Leave this window open until you finish.'
& wsl.exe -d $Distro -u $user --cd '~' --exec bash -lc 'jori setup'
