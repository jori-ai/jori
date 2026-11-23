; JoriSetup.exe — the Jori installer for Windows (NSIS, built on Linux by
; .github/workflows/installers.yml; locally: apps/windows/build.sh).
;
; A thin wrapper: it puts site/install.ps1 and the icon in
; %LOCALAPPDATA%\Jori and runs the script in a console window, where the real
; work happens (WSL, the Jori distro, the Linux installer, the sign-in task,
; Start-menu shortcuts, the setup page). Per-user, no administrator rights for
; itself: install.ps1 asks Windows for approval only if WSL must be turned on.
; The uninstaller removes the Startup item, shortcuts and, after asking, the distro.

Unicode true
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
Name "Jori"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Jori"
Icon "${ICON}"
UninstallIcon "${ICON}"
BrandingText "getjori.ai"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Jori"
VIAddVersionKey "FileDescription" "Jori installer"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Jori contributors"
ShowInstDetails show

!include "MUI2.nsh"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEPAGE_TITLE "Install Jori"
!define MUI_WELCOMEPAGE_TEXT "Jori is a personal assistant that runs on your own computer, through your Claude subscription.$\r$\n$\r$\nThis sets up a small Linux system for Jori inside Windows (WSL), installs Jori in it, and opens the setup page in your browser. It takes about ten minutes. If Windows asks for permission to turn on WSL, say yes; a restart may be needed, after which the install continues by itself.$\r$\n$\r$\nKeep this PC plugged in and awake while Jori should run."
!define MUI_FINISHPAGE_TITLE "Jori is installing"
!define MUI_FINISHPAGE_TEXT "The install continues in the console window that opened, then the setup page opens in your browser.$\r$\n$\r$\nLater, open Jori from the Start menu: Jori setup, Jori control room, Update Jori."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jori"

Section "Jori"
  SetOutPath "$INSTDIR"
  File "/oname=install.ps1" "${PS1}"
  File "/oname=jori.ico" "${ICON}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Jori"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Jori"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://getjori.ai"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\jori.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  DetailPrint "Starting the Jori install in a console window..."
  ; Its own window, not waited on: the script ends by serving the setup page.
  Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1"'
SectionEnd

Section "Uninstall"
  Delete "$SMSTARTUP\Jori.lnk"
  RMDir /r "$SMPROGRAMS\Jori"
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete Jori's Linux system and everything Jori stored in it (memory, settings, sign-ins)?$\r$\n$\r$\nChoose No to keep it; installing again picks it back up." IDNO keep
    nsExec::ExecToLog 'wsl.exe --unregister Jori'
    RMDir /r "$INSTDIR\wsl"
  keep:
  nsExec::ExecToLog 'wsl.exe --terminate Jori'
  Delete "$INSTDIR\install.ps1"
  Delete "$INSTDIR\jori.ico"
  Delete "$INSTDIR\keep-running.vbs"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
