; Only the canonical protected JSON written by InstallationControlStore/NSIS
; is accepted here. Helpers perform the full schema/ACL check under mutexes.
!include FileFunc.nsh
!macro KQ_OPERATION_FENCE PREFIX
Var KQFenceManifest
Var KQFenceInstallationId
Var KQFenceGeneration
Var KQFenceOperationId
Var KQSecurityPath
Var KQSecurityExpected
Var KQSecurityResult
Var KQFenceKind
Function ${PREFIX}KQ_VerifyControlPath
  StrCpy $0 0
  StrCpy $2 0
  StrCpy $4 0
  StrCpy $5 0
  StrCpy $7 0
  StrCpy $KQSecurityResult "0"
  System::Call 'advapi32::GetNamedSecurityInfoW(w "$KQSecurityPath", i 1, i 5, p 0, p 0, p 0, p 0, *p .r0) i.r1'
  ${If} $1 != 0
    Goto kq_security_cleanup
  ${EndIf}
  System::Call 'advapi32::GetSecurityDescriptorOwner(p r0, *p .r6, *i .r1) i.r3'
  ${If} $3 == 0
    Goto kq_security_cleanup
  ${EndIf}
  System::Call 'advapi32::ConvertSidToStringSidW(p r6, *p .r7) i.r1'
  ${If} $1 == 0
    Goto kq_security_cleanup
  ${EndIf}
  System::Call 'kernel32::lstrcpynW(w .r8, p r7, i 256) p'
  ${If} $8 != "S-1-5-32-544"
  ${AndIf} $8 != "S-1-5-18"
    Goto kq_security_cleanup
  ${EndIf}
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "$KQSecurityExpected", i 1, *p .r2, p 0) i.r1'
  ${If} $1 == 0
    Goto kq_security_cleanup
  ${EndIf}
  ; File readback can carry identical inherited ACEs without the AI metadata
  ; bit. Normalize only AI in these local descriptors, never the filesystem ACL.
  StrCpy $R9 $KQSecurityExpected 4
  ${If} $R9 == "D:AI"
    System::Call 'advapi32::SetSecurityDescriptorControl(p r0, i 0x400, i 0) i.r1'
    ${If} $1 == 0
      Goto kq_security_cleanup
    ${EndIf}
    System::Call 'advapi32::SetSecurityDescriptorControl(p r2, i 0x400, i 0) i.r1'
    ${If} $1 == 0
      Goto kq_security_cleanup
    ${EndIf}
  ${EndIf}
  System::Call 'advapi32::ConvertSecurityDescriptorToStringSecurityDescriptorW(p r0, i 1, i 4, *p .r4, p 0) i.r1'
  ${If} $1 == 0
    Goto kq_security_cleanup
  ${EndIf}
  System::Call 'advapi32::ConvertSecurityDescriptorToStringSecurityDescriptorW(p r2, i 1, i 4, *p .r5, p 0) i.r1'
  ${If} $1 == 0
    Goto kq_security_cleanup
  ${EndIf}
  System::Call 'kernel32::lstrcmpW(p r4, p r5) i.r9'
  ${If} $9 == 0
    StrCpy $KQSecurityResult "1"
  ${EndIf}
  kq_security_cleanup:
  ${If} $0 != 0
    System::Call 'kernel32::LocalFree(p r0) p.r1'
  ${EndIf}
  ${If} $2 != 0
    System::Call 'kernel32::LocalFree(p r2) p.r1'
  ${EndIf}
  ${If} $4 != 0
    System::Call 'kernel32::LocalFree(p r4) p.r1'
  ${EndIf}
  ${If} $5 != 0
    System::Call 'kernel32::LocalFree(p r5) p.r1'
  ${EndIf}
  ${If} $7 != 0
    System::Call 'kernel32::LocalFree(p r7) p.r1'
  ${EndIf}
  ${If} $KQSecurityResult != "1"
    SetErrorLevel 2
    Abort "A configuração global não tem proprietário e permissões confiáveis."
  ${EndIf}
FunctionEnd

Function ${PREFIX}KQ_AssertControlSecurity
  System::Call 'kernel32::GetFileAttributesW(w "$KQFenceManifest") i.r0'
  ${If} $0 == -1
    Goto kq_control_attributes_error
  ${EndIf}
  IntOp $1 $0 & 0x410
  ${If} $1 != 0
    Goto kq_control_attributes_error
  ${EndIf}
  StrCpy $KQSecurityPath "$KQFenceManifest"
  StrCpy $KQSecurityExpected "D:AI(A;ID;0x001f01ff;;;SY)(A;ID;0x001f01ff;;;BA)(A;ID;0x001200a9;;;AU)"
  Call ${PREFIX}KQ_VerifyControlPath
  ${GetParent} "$KQFenceManifest" $KQSecurityPath
  System::Call 'kernel32::GetFileAttributesW(w "$KQSecurityPath") i.r0'
  IntOp $1 $0 & 0x410
  ${If} $0 == -1
  ${OrIf} $1 != 16
    Goto kq_control_attributes_error
  ${EndIf}
  StrCpy $KQSecurityExpected "D:P(A;OICI;0x001f01ff;;;SY)(A;OICI;0x001f01ff;;;BA)(A;OICI;0x001200a9;;;AU)"
  Call ${PREFIX}KQ_VerifyControlPath
  ${GetParent} "$KQSecurityPath" $R0
  System::Call 'kernel32::GetFileAttributesW(w "$R0") i.r0'
  IntOp $1 $0 & 0x410
  ${If} $0 == -1
  ${OrIf} $1 != 16
    Goto kq_control_attributes_error
  ${EndIf}
  Return
  kq_control_attributes_error:
    SetErrorLevel 2
    Abort "O caminho da configuração global não é confiável."
FunctionEnd

Function ${PREFIX}KQ_ReadOperationFence
  StrCpy $KQFenceInstallationId ""
  StrCpy $KQFenceGeneration ""
  StrCpy $KQFenceOperationId ""
  StrCpy $KQFenceKind ""
  StrCpy $R4 "0"
  ClearErrors
  FileOpen $R0 "$KQFenceManifest" r
  IfErrors kq_fence_error
  kq_fence_read:
    FileRead $R0 $R1
    IfErrors kq_fence_done
    ${TrimNewLines} "$R1" $R1
    StrCpy $R2 $R1 21
    StrCmp $R2 '  "installationId": "' 0 +2
      StrCpy $KQFenceInstallationId $R1 36 21
    StrCpy $R2 $R1 16
    StrCmp $R2 '  "generation": ' 0 +3
      StrCpy $R3 $R1 -1
      StrCpy $KQFenceGeneration $R3 "" 16
    StrCmp $R1 '  "pending": {' 0 +2
      StrCpy $R4 "1"
    StrCmp $R1 '  },' 0 +2
      StrCpy $R4 "0"
    ${If} $R4 == "1"
      StrCpy $R2 $R1 20
      StrCmp $R2 '    "operationId": "' 0 +2
        StrCpy $KQFenceOperationId $R1 36 20
      StrCpy $R2 $R1 13
      StrCmp $R2 '    "kind": "' 0 +3
        StrCpy $R3 $R1 -2
        StrCpy $KQFenceKind $R3 "" 13
    ${EndIf}
    Goto kq_fence_read
  kq_fence_done:
  FileClose $R0
  ${If} $KQFenceInstallationId == ""
  ${OrIf} $KQFenceGeneration == ""
    Goto kq_fence_error
  ${EndIf}
  ${If} $KQFenceOperationId == ""
    System::Call 'ole32::CoCreateGuid(g .s) i.r0'
    Pop $R1
    ${If} $0 != 0
      Goto kq_fence_error
    ${EndIf}
    StrCpy $KQFenceOperationId $R1 36 1
  ${EndIf}
  ClearErrors
  Return
  kq_fence_error:
    SetErrorLevel 2
    Abort "Não foi possível validar a identidade e geração da operação."
FunctionEnd

Function ${PREFIX}KQ_AssertRemovalFence
  Push $KQFenceInstallationId
  Push $KQFenceGeneration
  Push $KQFenceOperationId
  Push $KQFenceKind
  Call ${PREFIX}KQ_ReadOperationFence
  Pop $R5
  Pop $R6
  Pop $R7
  Pop $R8
  ${If} $R8 != $KQFenceInstallationId
  ${OrIf} $R7 != $KQFenceGeneration
  ${OrIf} $R6 != $KQFenceOperationId
  ${OrIf} $R5 != $KQFenceKind
    SetErrorLevel 2
    Abort "A operação ficou obsoleta. Nenhum arquivo será removido."
  ${EndIf}
FunctionEnd
!macroend

!define KQ_FENCE_ARGS '--installation-id $KQFenceInstallationId --operation-id $KQFenceOperationId --expected-generation $KQFenceGeneration'
