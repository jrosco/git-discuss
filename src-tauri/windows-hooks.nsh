!include "WinMessages.nsh"
!include "StrFunc.nsh"
${StrStr}
${StrRep}
${UnStrRep}

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 "$0" "$INSTDIR\resources\bin"
  ${If} $1 == ""
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\resources\bin"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR\resources\bin"
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrRep} $1 "$0" "$INSTDIR\resources\bin;" ""
  ${UnStrRep} $1 "$1" ";$INSTDIR\resources\bin" ""
  ${UnStrRep} $1 "$1" "$INSTDIR\resources\bin" ""
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
