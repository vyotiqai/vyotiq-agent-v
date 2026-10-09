; Custom NSIS hooks, included by electron-builder (nsis.include).

; Explorer's "Open in Agent V", on a folder and on a folder's background. The
; app reads the folder from its command line (src/main/app/deepLinks.ts,
; workspacePathFromArgv). SHCTX is HKCU for a per-user install.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Directory\shell\AgentV" "" "Open in Agent V"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\AgentV" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\AgentV\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\AgentV" "" "Open in Agent V"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\AgentV" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\AgentV\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

; Uninstall: take the Windows sandbox's low integrity labels off the folders
; it labelled, before the app and (if chosen) its data are removed, take the
; `vyotiq` command off PATH, and drop the Explorer entries. Skipped when the
; uninstaller runs as part of an update: the labels are still wanted, the
; new install lands in the same folder, so the PATH entry still holds, and it
; writes the Explorer entries. userData is %APPDATA%\vyotiq (package.json
; name); paths compare without case.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\resources\uninstall\restore-sandbox-labels.ps1"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall\restore-sandbox-labels.ps1" -Record "$APPDATA\${APP_PACKAGE_NAME}\sandbox\labels.json"'
      Pop $0
    ${endIf}
    ${if} ${FileExists} "$INSTDIR\resources\cli\path-entry.ps1"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\path-entry.ps1" -Action remove -Dir "$INSTDIR\resources\cli"'
      Pop $0
    ${endIf}
    DeleteRegKey SHCTX "Software\Classes\Directory\shell\AgentV"
    DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\AgentV"
  ${endIf}
!macroend
