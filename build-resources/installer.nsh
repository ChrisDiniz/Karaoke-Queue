!include LogicLib.nsh
!include TextFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include installation-operation.nsh
!include installation-fence.nsh

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
  ${If} $KQManifestReinstall == "1"
    Call KQ_LockInstallationRecovery
  ${ElseIf} $KQManifestPending == "1"
    Call KQ_LockInstallationRecovery
  ${ElseIf} $KQInstallerExistingMachineInstall == "1"
    Call KQ_PrepareAndLockInstallation
  ${Else}
    Call KQ_CreateMaintenanceMutexHandles
    Call KQ_TakeMaintenanceMutexes
    ${If} $KQBootstrapPending == "1"
      Call KQ_AssertControlSecurity
      Call KQ_AssertRemovalFence
    ${EndIf}
  ${EndIf}
  !endif
!macroend

!ifdef BUILD_UNINSTALLER
!insertmacro KQ_OPERATION_TREE "un."
!insertmacro KQ_OPERATION_FENCE "un."
; The generated components page is internal and always skipped: the final
; mandatory section exists only to release on the section worker thread.
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.KQ_SkipInternalComponents
Function un.KQ_SkipInternalComponents
  Abort
FunctionEnd
!macro customUnInit
  StrCmp $INSTDIR "$PROGRAMFILES64\Karaoke Queue" +3
    SetErrorLevel 2
    Quit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  Call un.KQ_EnterOperationTree
  System::Call 'SHELL32::SHGetKnownFolderPath(g "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}", i 0, p 0, *p .r2)i.r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
  System::Call 'OLE32::CoTaskMemFree(p r2)'
  StrCpy $KQFenceManifest "$0\KaraokeQueue\installation.json"
  Call un.KQ_AssertControlSecurity
  Call un.KQ_ReadOperationFence
  ${If} ${isUpdated}
  ${AndIf} $KQOperationDelegated != "1"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
Var KQUninstallAdminMutexHandle
Var KQUninstallRuntimeMutexHandle
Var KQUninstallAdminMutexOwned
Var KQUninstallRuntimeMutexOwned

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ClearErrors
    ExecWait '"$INSTDIR\Karaoke Queue.exe" --kq-install-admin uninstall-cleanup ${KQ_FENCE_ARGS}' $0
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Não foi possível verificar e remover os atalhos gerenciados. A desinstalação foi interrompida sem alterar dados." /SD IDOK
      Abort
    ${EndIf}
    ${If} $0 != 0
      SetErrorLevel $0
      MessageBox MB_OK|MB_ICONSTOP "Os atalhos gerenciados não foram removidos com segurança (código $0). A desinstalação foi interrompida." /SD IDOK
      Abort
    ${EndIf}
    ; The helper leaves a durable uninstall intent and exits its own locks.
    ; NSIS then owns both global mutexes through the final uninstaller mutation.
    StrCpy $KQFenceKind "uninstall"
    Call un.KQ_CreateUninstallMutexHandles
    Call un.KQ_TakeUninstallMutexes
    Call un.KQ_AssertControlSecurity
    Call un.KQ_AssertRemovalFence
  ${EndIf}
!macroend

Function un.KQ_AbortUninstallBusy
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONSTOP "A instalação está ocupada ou exige recuperação. Nenhum processo será encerrado à força; execute novamente a desinstalação após resolver o bloqueio." /SD IDOK
  Call un.KQ_CloseUninstallMutexHandles
  Abort
FunctionEnd

Function un.KQ_ReleaseUninstallMutexOwnership
  ${If} $KQUninstallRuntimeMutexOwned == "1"
    System::Call 'kernel32::ReleaseMutex(p $KQUninstallRuntimeMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQUninstallRuntimeMutexOwned "0"
  ${EndIf}
  ${If} $KQUninstallAdminMutexOwned == "1"
    System::Call 'kernel32::ReleaseMutex(p $KQUninstallAdminMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQUninstallAdminMutexOwned "0"
  ${EndIf}
FunctionEnd

Function un.KQ_CloseUninstallMutexHandles
  Call un.KQ_ReleaseUninstallMutexOwnership
  ${If} $KQUninstallRuntimeMutexHandle != ""
  ${AndIf} $KQUninstallRuntimeMutexHandle != "0"
    System::Call 'kernel32::CloseHandle(p $KQUninstallRuntimeMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQUninstallRuntimeMutexHandle "0"
  ${EndIf}
  ${If} $KQUninstallAdminMutexHandle != ""
  ${AndIf} $KQUninstallAdminMutexHandle != "0"
    System::Call 'kernel32::CloseHandle(p $KQUninstallAdminMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQUninstallAdminMutexHandle "0"
  ${EndIf}
FunctionEnd

Function un.KQ_CreateUninstallMutexHandles
  StrCpy $KQUninstallAdminMutexHandle "0"
  StrCpy $KQUninstallRuntimeMutexHandle "0"
  StrCpy $KQUninstallAdminMutexOwned "0"
  StrCpy $KQUninstallRuntimeMutexOwned "0"

  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Call un.KQ_AbortUninstallBusy
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::CreateMutexExW(p r2, w "Global\com.karaoke.queue.install-admin.v1", i 0, i 0x00120001) p.r3'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r0) p.r4'
  ${If} $3 == 0
    Call un.KQ_AbortUninstallBusy
  ${EndIf}
  StrCpy $KQUninstallAdminMutexHandle $3

  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)(A;;0x00120001;;;AU)(A;;0x00120001;;;OW)S:(ML;;NW;;;ME)", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Call un.KQ_AbortUninstallBusy
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::CreateMutexExW(p r2, w "Global\com.karaoke.queue.runtime.v1", i 0, i 0x00120001) p.r3'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r0) p.r4'
  ${If} $3 == 0
    Call un.KQ_AbortUninstallBusy
  ${EndIf}
  StrCpy $KQUninstallRuntimeMutexHandle $3
FunctionEnd

Function un.KQ_TakeUninstallMutexes
  System::Call 'kernel32::WaitForSingleObject(p $KQUninstallAdminMutexHandle, i 30000) i.r0'
  ${If} $0 != 0
    ${If} $0 == 0x80
      System::Call 'kernel32::ReleaseMutex(p $KQUninstallAdminMutexHandle) i.r1'
    ${EndIf}
    Call un.KQ_AbortUninstallBusy
  ${EndIf}
  StrCpy $KQUninstallAdminMutexOwned "1"
  System::Call 'kernel32::WaitForSingleObject(p $KQUninstallRuntimeMutexHandle, i 30000) i.r0'
  ${If} $0 != 0
    ${If} $0 == 0x80
      System::Call 'kernel32::ReleaseMutex(p $KQUninstallRuntimeMutexHandle) i.r1'
    ${EndIf}
    Call un.KQ_AbortUninstallBusy
  ${EndIf}
  StrCpy $KQUninstallRuntimeMutexOwned "1"
FunctionEnd

!macro customUnInstallSection
  Section "-un.KQFinish"
    SectionIn RO
    Call un.KQ_CloseUninstallMutexHandles
  SectionEnd
!macroend
!endif

!ifndef BUILD_UNINSTALLER
!insertmacro KQ_OPERATION_TREE ""
!insertmacro KQ_OPERATION_FENCE ""

!define KQ_INSTALLATION_DIRECTORY_SDDL "O:BAD:P(A;OICI;0x001f01ff;;;SY)(A;OICI;0x001f01ff;;;BA)(A;OICI;0x001200a9;;;AU)"
!define KQ_INSTALLATION_OWNER_SDDL "O:BA"

Var KQInstallationDirectory
Var KQInstallationManifest
Var KQInstallerExistingMachineInstall
Var KQProgramDataDirectory
Var KQManifestUnconfigured
Var KQManifestPending
Var KQManifestUninstallPending
Var KQManifestReinstall
Var KQManifestRole
Var KQBootstrapPending
Var KQManifestRestored
Var KQRegisteredInstallDirectory
Var KQMaintenancePlayer
Var KQMaintenanceCombined
Var KQMaintenanceTargetRole
Var KQAdminMutexHandle
Var KQRuntimeMutexHandle
Var KQAdminMutexOwned
Var KQRuntimeMutexOwned

Function KQ_MaintenancePageCreate
  ${If} $KQManifestReinstall == "1"
    Abort
  ${EndIf}
  ${If} $KQInstallerExistingMachineInstall != "1"
    Abort
  ${EndIf}
  ${If} $KQManifestUnconfigured == "1"
    Abort
  ${EndIf}
  ${If} $KQManifestPending == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 22u "Selecione a função que ficará ativa após a manutenção:"
  Pop $1
  ${NSD_CreateRadioButton} 0 30u 100% 20u "Reprodutor"
  Pop $KQMaintenancePlayer
  ${NSD_CreateRadioButton} 0 56u 100% 20u "Tudo em um"
  Pop $KQMaintenanceCombined
  ${NSD_Check} $KQMaintenancePlayer
  nsDialogs::Show
FunctionEnd

Function KQ_ReadManifestUnconfigured
  StrCpy $KQManifestUnconfigured "0"
  StrCpy $KQManifestPending "0"
  StrCpy $KQManifestUninstallPending "0"
  StrCpy $KQManifestRole "unknown"
  StrCpy $KQManifestRestored "0"
  IfFileExists "$KQInstallationManifest" 0 kq_manifest_status_done
  ClearErrors
  FileOpen $0 "$KQInstallationManifest" r
  IfErrors kq_manifest_status_done
  kq_manifest_status_read:
    FileRead $0 $1
    IfErrors kq_manifest_status_close
    ${TrimNewLines} "$1" $1
    StrCmp $1 "  $\"role$\": null," kq_manifest_role_null
    StrCmp $1 "  $\"role$\": null" kq_manifest_role_null
    StrCmp $1 "  $\"role$\": $\"player$\"," kq_manifest_role_player
    StrCmp $1 "  $\"role$\": $\"player$\"" kq_manifest_role_player
    StrCmp $1 "  $\"role$\": $\"combined$\"," kq_manifest_role_combined
    StrCmp $1 "  $\"role$\": $\"combined$\"" kq_manifest_role_combined
    StrCmp $1 "    $\"kind$\": $\"uninstall$\"," kq_manifest_uninstall_pending
    StrCmp $1 "    $\"kind$\": $\"uninstall$\"" kq_manifest_uninstall_pending
    StrCmp $1 "    $\"kind$\": $\"restore-installation$\"," kq_manifest_restored
    StrCmp $1 "    $\"kind$\": $\"restore-installation$\"" kq_manifest_restored
    StrCmp $1 "  $\"status$\": $\"unconfigured$\"," kq_manifest_unconfigured
    StrCmp $1 "  $\"status$\": $\"unconfigured$\"" kq_manifest_unconfigured
    StrCmp $1 "  $\"status$\": $\"pending$\"," kq_manifest_pending
    StrCmp $1 "  $\"status$\": $\"pending$\"" kq_manifest_pending
    StrCmp $1 "  $\"status$\": $\"repairRequired$\"," kq_manifest_pending
    StrCmp $1 "  $\"status$\": $\"repairRequired$\"" kq_manifest_pending
    Goto kq_manifest_status_read
  kq_manifest_role_null:
    StrCpy $KQManifestRole "null"
    Goto kq_manifest_status_read
  kq_manifest_role_player:
    StrCpy $KQManifestRole "player"
    Goto kq_manifest_status_read
  kq_manifest_role_combined:
    StrCpy $KQManifestRole "combined"
    Goto kq_manifest_status_read
  kq_manifest_uninstall_pending:
    StrCpy $KQManifestUninstallPending "1"
    StrCpy $KQManifestPending "1"
    Goto kq_manifest_status_read
  kq_manifest_restored:
    StrCpy $KQManifestRestored "1"
    Goto kq_manifest_status_read
  kq_manifest_unconfigured:
    StrCpy $KQManifestUnconfigured "1"
    Goto kq_manifest_status_read
  kq_manifest_pending:
    StrCpy $KQManifestPending "1"
    Goto kq_manifest_status_read
  kq_manifest_status_close:
  FileClose $0
  kq_manifest_status_done:
FunctionEnd

Function KQ_MaintenancePageLeave
  ${If} $KQManifestReinstall == "1"
    Return
  ${EndIf}
  ${NSD_GetState} $KQMaintenancePlayer $0
  ${NSD_GetState} $KQMaintenanceCombined $1
  ${If} $0 != ${BST_CHECKED}
  ${AndIf} $1 != ${BST_CHECKED}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Escolha Reprodutor ou Tudo em um para continuar." /SD IDOK
    Abort
  ${EndIf}

  ${If} $0 == ${BST_CHECKED}
    StrCpy $KQMaintenanceTargetRole "player"
  ${Else}
    StrCpy $KQMaintenanceTargetRole "combined"
  ${EndIf}
FunctionEnd

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom KQ_MaintenancePageCreate KQ_MaintenancePageLeave
!macroend

Function KQ_AbortUnsafeInstallationState
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONSTOP "Não é possível continuar com segurança. Há uma instalação legada ou um estado global de instalação incompleto. Nenhum perfil ou banco foi movido ou excluído. Resolva o conflito antes de instalar." /SD IDOK
  Abort
FunctionEnd

Function KQ_AbortMaintenanceBusy
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONEXCLAMATION "O Karaoke Queue ainda está aberto ou a instalação está ocupada. Feche o aplicativo normalmente e tente novamente. Nenhum arquivo será substituído à força." /SD IDOK
  Abort
FunctionEnd

Function KQ_ReleaseMaintenanceMutexOwnership
  ${If} $KQRuntimeMutexOwned == "1"
    System::Call 'kernel32::ReleaseMutex(p $KQRuntimeMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQRuntimeMutexOwned "0"
  ${EndIf}
  ${If} $KQAdminMutexOwned == "1"
    System::Call 'kernel32::ReleaseMutex(p $KQAdminMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQAdminMutexOwned "0"
  ${EndIf}
FunctionEnd

Function KQ_CloseMaintenanceMutexHandles
  Call KQ_ReleaseMaintenanceMutexOwnership
  ${If} $KQRuntimeMutexHandle != 0
    System::Call 'kernel32::CloseHandle(p $KQRuntimeMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQRuntimeMutexHandle 0
  ${EndIf}
  ${If} $KQAdminMutexHandle != 0
    System::Call 'kernel32::CloseHandle(p $KQAdminMutexHandle) i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $KQAdminMutexHandle 0
  ${EndIf}
FunctionEnd


Function KQ_CreateMaintenanceMutexHandles
  StrCpy $KQAdminMutexHandle 0
  StrCpy $KQRuntimeMutexHandle 0
  StrCpy $KQAdminMutexOwned "0"
  StrCpy $KQRuntimeMutexOwned "0"

  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::CreateMutexExW(p r2, w "Global\com.karaoke.queue.install-admin.v1", i 0, i 0x00120001) p.r3'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r0) p.r4'
  ${If} $3 == 0
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  StrCpy $KQAdminMutexHandle $3

  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)(A;;0x00120001;;;AU)(A;;0x00120001;;;OW)S:(ML;;NW;;;ME)", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::CreateMutexExW(p r2, w "Global\com.karaoke.queue.runtime.v1", i 0, i 0x00120001) p.r3'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r0) p.r4'
  ${If} $3 == 0
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  StrCpy $KQRuntimeMutexHandle $3
FunctionEnd

Function KQ_TakeMaintenanceMutexes
  System::Call 'kernel32::WaitForSingleObject(p $KQAdminMutexHandle, i 0) i.r0'
  ${If} $0 != 0
    ${If} $0 == 0x80
      System::Call 'kernel32::ReleaseMutex(p $KQAdminMutexHandle) i.r1'
    ${EndIf}
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  StrCpy $KQAdminMutexOwned "1"
  System::Call 'kernel32::WaitForSingleObject(p $KQRuntimeMutexHandle, i 0) i.r0'
  ${If} $0 != 0
    ${If} $0 == 0x80
      System::Call 'kernel32::ReleaseMutex(p $KQRuntimeMutexHandle) i.r1'
    ${EndIf}
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  StrCpy $KQRuntimeMutexOwned "1"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x410
    ${If} $1 != 0x10
      SetErrorLevel 2
      Abort "O diretório da aplicação não é confiável."
    ${EndIf}
  ${EndIf}
FunctionEnd

Function KQ_PrepareAndLockInstallation
  Call KQ_CreateMaintenanceMutexHandles
  ClearErrors
  ExecWait '"$INSTDIR\Karaoke Queue.exe" --kq-install-admin prepare-update ${KQ_FENCE_ARGS}' $0
  ${If} ${Errors}
    Call KQ_AbortMaintenanceBusy
  ${EndIf}
  ${If} $0 != 0
    Call KQ_AbortMaintenanceBusy
  ${EndIf}
  StrCpy $KQManifestPending "1"
  ${If} $KQFenceKind == ""
    StrCpy $KQFenceKind "prepare-update"
  ${EndIf}
  Call KQ_TakeMaintenanceMutexes
  Call KQ_AssertControlSecurity
  Call KQ_AssertRemovalFence
FunctionEnd

Function KQ_LockInstallationRecovery
  ; A durable uninstall intent is not an update intent. Take the same global
  ; locks directly so a concurrent uninstaller or installer cannot replace
  ; files while recovery is running.
  Call KQ_CreateMaintenanceMutexHandles
  Call KQ_TakeMaintenanceMutexes
  Call KQ_AssertControlSecurity
  Call KQ_AssertRemovalFence
FunctionEnd

Function KQ_ResolveInstallationControlPaths
  Push $0
  Push $1
  Push $2
  StrCpy $2 0
  System::Call 'SHELL32::SHGetKnownFolderPath(g "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}", i 0, p 0, *p .r2)i.r1'
  ${If} $1 == 0
    System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
  ${EndIf}
  ${If} $2 != 0
    System::Call 'OLE32::CoTaskMemFree(p r2)'
  ${EndIf}
  ${If} $0 == ""
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  StrCpy $KQProgramDataDirectory $0
  StrCpy $KQInstallationDirectory "$KQProgramDataDirectory\KaraokeQueue"
  StrCpy $KQInstallationManifest "$KQInstallationDirectory\installation.json"
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function KQ_InitializeInstallationControl
  System::Call 'kernel32::GetFileAttributesW(w "$KQProgramDataDirectory") i.r0'
  ${If} $0 == -1
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  IntOp $1 $0 & 0x10
  ${If} $1 == 0
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  IntOp $1 $0 & 0x400
  ${If} $1 != 0
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}

  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "${KQ_INSTALLATION_DIRECTORY_SDDL}", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Goto kq_init_acl_failed
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::CreateDirectoryW(w "$KQInstallationDirectory", p r2) i.r3'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r0) p.r4'
  ${If} $3 == 0
    Goto kq_init_directory_failed
  ${EndIf}

  System::Call 'ole32::CoCreateGuid(g .s) i.r0'
  Pop $4
  ${If} $0 != 0
    Goto kq_init_manifest_failed
  ${EndIf}
  StrCpy $5 $4 36 1
  System::Call 'ole32::CoCreateGuid(g .s) i.r0'
  Pop $7
  ${If} $0 != 0
    Goto kq_init_manifest_failed
  ${EndIf}
  StrCpy $KQFenceOperationId $7 36 1
  FileOpen $6 "$KQInstallationManifest" w
  IfErrors kq_init_manifest_failed
  FileWrite $6 "{$\r$\n"
  FileWrite $6 "  $\"formatVersion$\": 1,$\r$\n"
  FileWrite $6 "  $\"installationId$\": $\"$5$\",$\r$\n"
  FileWrite $6 "  $\"generation$\": 0,$\r$\n"
  FileWrite $6 "  $\"role$\": null,$\r$\n"
  FileWrite $6 "  $\"status$\": $\"pending$\",$\r$\n"
  FileWrite $6 "  $\"identityRevision$\": 0,$\r$\n"
  FileWrite $6 "  $\"pending$\": {$\r$\n"
  FileWrite $6 "    $\"operationId$\": $\"$KQFenceOperationId$\",$\r$\n"
  FileWrite $6 "    $\"kind$\": $\"prepare-update$\",$\r$\n"
  FileWrite $6 "    $\"baseGeneration$\": 0,$\r$\n"
  FileWrite $6 "    $\"role$\": null$\r$\n"
  FileWrite $6 "  },$\r$\n"
  FileWrite $6 "  $\"lastCompletedOperation$\": null$\r$\n"
  FileWrite $6 "}$\r$\n"
  FileClose $6
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "${KQ_INSTALLATION_OWNER_SDDL}", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Goto kq_init_manifest_failed
  ${EndIf}
  System::Call 'advapi32::SetFileSecurityW(w "$KQInstallationManifest", i 0x1, p r0) i.r2'
  System::Call 'kernel32::LocalFree(p r0) p.r3'
  ${If} $2 == 0
    Goto kq_init_manifest_failed
  ${EndIf}
  Return

  kq_init_directory_failed:
  kq_init_acl_failed:
  kq_init_manifest_failed:
  Call KQ_AbortUnsafeInstallationState
FunctionEnd

!macro customInit
  StrCmp $INSTDIR "$PROGRAMFILES64\Karaoke Queue" +3
    SetErrorLevel 2
    Quit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  Call KQ_EnterOperationTree
  Call KQ_ResolveInstallationControlPaths
  StrCpy $KQBootstrapPending "0"
  StrCpy $KQInstallerExistingMachineInstall "0"
  StrCpy $KQManifestReinstall "0"
  StrCpy $KQRegisteredInstallDirectory ""

  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $0 != ""
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    Call KQ_AbortUnsafeInstallationState
  ${EndIf}
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    StrCpy $KQInstallerExistingMachineInstall "1"
    StrCpy $KQRegisteredInstallDirectory $0
  ${EndIf}

  IfFileExists "$KQInstallationManifest" kq_custom_init_manifest_exists kq_custom_init_manifest_missing
  kq_custom_init_manifest_exists:
    StrCpy $KQFenceManifest "$KQInstallationManifest"
    Call KQ_AssertControlSecurity
    Call KQ_ReadManifestUnconfigured
    Call KQ_ReadOperationFence
    ${If} $KQInstallerExistingMachineInstall == "0"
    ${AndIf} $KQManifestRole == "null"
    ${AndIf} $KQFenceGeneration == "0"
    ${AndIf} $KQFenceKind == "prepare-update"
      StrCpy $KQBootstrapPending "1"
      Goto kq_custom_init_done
    ${EndIf}
    ${If} $KQManifestUninstallPending == "1"
      ${If} $KQInstallerExistingMachineInstall == "1"
      ${AndIf} $KQRegisteredInstallDirectory != "$INSTDIR"
        Call KQ_AbortUnsafeInstallationState
      ${EndIf}
      StrCpy $KQManifestReinstall "1"
      Goto kq_custom_init_done
    ${EndIf}
    ${If} $KQManifestPending == "1"
      ${If} $KQFenceKind == "prepare-update"
      ${OrIf} $KQFenceKind == "confirm-initial"
      ${OrIf} $KQFenceKind == "change-role"
        Goto kq_custom_init_done
      ${EndIf}
    ${EndIf}
    ${If} $KQInstallerExistingMachineInstall == "0"
      ; A ready/orphaned machine record is a conflict, not permission to create a second install.
      Call KQ_AbortUnsafeInstallationState
    ${EndIf}
    Goto kq_custom_init_done
  kq_custom_init_manifest_missing:
    IfFileExists "$KQInstallationDirectory\*.*" kq_custom_init_directory_conflict kq_custom_init_no_directory
  kq_custom_init_directory_conflict:
    Call KQ_AbortUnsafeInstallationState
  kq_custom_init_no_directory:
    ${If} $KQInstallerExistingMachineInstall == "1"
      Call KQ_AbortUnsafeInstallationState
    ${EndIf}
    Call KQ_InitializeInstallationControl
    StrCpy $KQBootstrapPending "1"
    StrCpy $KQManifestPending "1"
  kq_custom_init_done:
  StrCpy $KQFenceManifest "$KQInstallationManifest"
  Call KQ_ReadOperationFence
!macroend

!macro customUnInstallCheck
  ${If} $KQManifestPending == "1"
  ${AndIf} $KQRegisteredInstallDirectory == "$INSTDIR"
    IfFileExists "$INSTDIR\Uninstall Karaoke Queue.exe" kq_old_uninstall_check_result
    Call KQ_AssertControlSecurity
    Call KQ_AssertRemovalFence
    ClearErrors
    StrCpy $R0 0
    Return
  ${EndIf}
  kq_old_uninstall_check_result:
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    SetErrorLevel 2
    Abort "A versão anterior não foi removida com segurança. O estado pendente foi preservado."
  ${EndIf}
!macroend

!macro customInstall
  ${If} $KQManifestReinstall == "1"
    Call KQ_ReleaseMaintenanceMutexOwnership
    ClearErrors
    ExecWait '"$INSTDIR\Karaoke Queue.exe" --kq-install-admin restore-after-uninstall ${KQ_FENCE_ARGS}' $0
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Não foi possível restaurar a instalação após a desinstalação interrompida. O estado anterior permanece protegido." /SD IDOK
      Abort
    ${EndIf}
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "A restauração não foi confirmada (código $0). O aplicativo permanecerá bloqueado até nova recuperação." /SD IDOK
      Abort
    ${EndIf}
    Call KQ_CloseMaintenanceMutexHandles
  ${Else}
    ${If} $KQManifestPending == "1"
      Call KQ_ReleaseMaintenanceMutexOwnership
      ClearErrors
      ExecWait '"$INSTDIR\Karaoke Queue.exe" --kq-install-admin repair-pending ${KQ_FENCE_ARGS}' $0
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "Não foi possível iniciar a recuperação segura. A função e os dados confirmados foram preservados." /SD IDOK
        Abort
      ${EndIf}
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "A operação pendente não foi reconciliada (código $0). A instalação permanece bloqueada para recuperação." /SD IDOK
        Abort
      ${EndIf}
      Call KQ_CloseMaintenanceMutexHandles
    ${EndIf}
    ; Apply a selected function only after the user committed to Install and the
    ; package files are in place. Cancelling earlier leaves the role untouched.
    ${If} $KQMaintenanceTargetRole != ""
      Call KQ_ReadOperationFence
      ClearErrors
      ExecWait '"$INSTDIR\Karaoke Queue.exe" --kq-install-admin change-role ${KQ_FENCE_ARGS} --role $KQMaintenanceTargetRole' $0
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "Não foi possível iniciar a manutenção segura. A função anterior foi preservada." /SD IDOK
        Abort
      ${EndIf}
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "A alteração não foi confirmada (código $0). A instalação exige recuperação antes de abrir o aplicativo." /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}

  ${EndIf}
  Call KQ_CloseMaintenanceMutexHandles
!macroend

!endif
