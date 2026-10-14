; electron-builder 26.15.3 默认 CHECK_APP_RUNNING 会运行 PowerShell/cmd。
; 安装、旧版卸载都改用随 NSIS 提供的原生插件；不强杀仍在干活的后台进程。
!macro customCheckAppRunning
  Push $R0
  Push $R1
  StrCpy $R1 0
  ${Do}
    nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 603 ; 没有这个进程
      ${ExitDo}
    ${EndIf}
    ${If} $R0 != 0 ; 无法核对也不接触旧安装
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} ${isUpdated}
      ; 应用在安装程序 spawn 成功后退出；等它释放文件，不发结束进程命令。
      ${If} $R1 >= 600
        MessageBox MB_OK|MB_ICONEXCLAMATION "应用或后台任务尚未退出，请关闭后手动安装更新。" /SD IDOK
        ; 静默安装时上面的提示不会出现；应用已经退出了，放弃前把原来的应用重新打开，不让人落空（这时还什么都没换）。
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
        SetErrorLevel 2
        Quit
      ${EndIf}
      Sleep 100
      IntOp $R1 $R1 + 1
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "请先退出派活工作台并等待后台任务结束，再继续安装。" /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${Loop}
  nsProcess::_Unload
  Pop $R1
  Pop $R0
!macroend
