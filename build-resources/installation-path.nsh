; Per-machine executable trust for a selected local directory. Existing ancestors
; are read-only: never rewrite ACLs on somebody else's folders. Newly created
; directories receive the canonical protected DACL at creation time.
!include FileFunc.nsh
!macro KQ_INSTALL_PATH PREFIX
Var KQPathWalk
Var KQPathMask
Var KQPathSafe
Var KQPathSid
Var KQPathPrivileged
Var KQPathSD
Var KQPathACL
Var KQPathInfo
Var KQPathCount
Var KQPathIndex
Var KQPathAce
Var KQPathCreate
Function ${PREFIX}KQ_PathPrivilegedSid
  StrCpy $KQPathPrivileged 0
  System::Call 'advapi32::IsWellKnownSid(p $KQPathSid, i 22) i.r0'
  ${If} $0 != 0
    StrCpy $KQPathPrivileged 1
    Return
  ${EndIf}
  System::Call 'advapi32::IsWellKnownSid(p $KQPathSid, i 26) i.r0'
  ${If} $0 != 0
    StrCpy $KQPathPrivileged 1
    Return
  ${EndIf}
  System::Call 'advapi32::ConvertSidToStringSidW(p $KQPathSid, *p .r1) i.r0'
  ${If} $0 == 0
    Return
  ${EndIf}
  System::Call 'kernel32::lstrcpynW(w .r2, p r1, i 256) p'
  System::Call 'kernel32::LocalFree(p r1) p'
  ${If} $2 == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
    StrCpy $KQPathPrivileged 1
  ${EndIf}
FunctionEnd
Function ${PREFIX}KQ_VerifyPathACL
  StrCpy $KQPathSafe 0
  StrCpy $KQPathSD 0
  StrCpy $KQPathInfo 0
  StrCpy $3 0
  StrCpy $4 0
  StrCpy $5 0
  System::Call 'advapi32::GetNamedSecurityInfoW(w "$KQPathWalk", i 1, i 5, *p .r3, p 0, *p .r4, p 0, *p .r5) i.r0'
  StrCpy $KQPathSD $5
  StrCpy $KQPathACL $4
  StrCpy $KQPathSid $3
  ${If} $0 != 0
    Goto kq_path_acl_cleanup
  ${EndIf}
  Call ${PREFIX}KQ_PathPrivilegedSid
  ${If} $KQPathPrivileged != 1
    Goto kq_path_acl_cleanup
  ${EndIf}
  System::Call 'advapi32::IsValidAcl(p $KQPathACL) i.r0'
  ${If} $0 == 0
    Goto kq_path_acl_cleanup
  ${EndIf}
  System::Alloc 12
  Pop $KQPathInfo
  System::Call 'advapi32::GetAclInformation(p $KQPathACL, p $KQPathInfo, i 12, i 2) i.r0'
  ${If} $0 == 0
    Goto kq_path_acl_cleanup
  ${EndIf}
  System::Call '*$KQPathInfo(i .r0, i, i)'
  StrCpy $KQPathCount $0
  StrCpy $KQPathIndex 0
  kq_path_acl_loop:
    ${If} $KQPathIndex >= $KQPathCount
      StrCpy $KQPathSafe 1
      Goto kq_path_acl_cleanup
    ${EndIf}
    System::Call 'advapi32::GetAce(p $KQPathACL, i $KQPathIndex, *p .r0) i.r1'
    ${If} $1 == 0
      Goto kq_path_acl_cleanup
    ${EndIf}
    StrCpy $KQPathAce $0
    System::Call '*$KQPathAce(&i1 .r0, &i1 .r1, &i2, i .r2)'
    IntOp $1 $1 & 8
    ${If} $1 == 0
    ${AndIf} $0 != 1
      ${If} $0 != 0
        Goto kq_path_acl_cleanup
      ${EndIf}
      IntOp $2 $2 & $KQPathMask
      ${If} $2 != 0
        IntOp $KQPathSid $KQPathAce + 8
        Call ${PREFIX}KQ_PathPrivilegedSid
        ${If} $KQPathPrivileged != 1
          Goto kq_path_acl_cleanup
        ${EndIf}
      ${EndIf}
    ${EndIf}
    IntOp $KQPathIndex $KQPathIndex + 1
    Goto kq_path_acl_loop
  kq_path_acl_cleanup:
    ${If} $KQPathSD != 0
      System::Call 'kernel32::LocalFree(p $KQPathSD) p'
    ${EndIf}
    ${If} $KQPathInfo != 0
      System::Free $KQPathInfo
    ${EndIf}
FunctionEnd
Function ${PREFIX}KQ_EnsurePathTree
  System::Call 'kernel32::GetFileAttributesW(w "$KQPathWalk") i.r0'
  ${If} $0 == -1
    ${If} $KQPathCreate != 1
      Goto kq_path_unsafe
    ${EndIf}
    Push $KQPathWalk
    ${GetParent} "$KQPathWalk" $KQPathWalk
    ${If} $KQPathWalk == ""
      Goto kq_path_unsafe
    ${EndIf}
    StrLen $0 $KQPathWalk
    ${If} $0 == 2
      StrCpy $KQPathWalk "$KQPathWalk\"
    ${EndIf}
    Call ${PREFIX}KQ_EnsurePathTree
    Pop $KQPathWalk
    System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)", i 1, *p .r0, p 0) i.r1'
    ${If} $1 == 0
      Goto kq_path_unsafe
    ${EndIf}
    System::Call '*(i 12, p r0, i 0) p.r2'
    System::Call 'kernel32::CreateDirectoryW(w "$KQPathWalk", p r2) i.r3'
    System::Free $2
    System::Call 'kernel32::LocalFree(p r0) p'
    ${If} $3 == 0
      Goto kq_path_unsafe
    ${EndIf}
  ${Else}
    IntOp $1 $0 & 0x410
    ${If} $1 != 16
      Goto kq_path_unsafe
    ${EndIf}
    Push $KQPathWalk
    StrLen $0 $KQPathWalk
    ${If} $0 > 3
      ${GetParent} "$KQPathWalk" $KQPathWalk
      StrLen $0 $KQPathWalk
      ${If} $0 == 2
        StrCpy $KQPathWalk "$KQPathWalk\"
      ${EndIf}
      Call ${PREFIX}KQ_EnsurePathTree
    ${EndIf}
    Pop $KQPathWalk
  ${EndIf}
  StrCpy $KQPathMask 0x500D0040
  ${If} $KQPathWalk == $INSTDIR
    StrCpy $KQPathMask 0x500D0156
  ${EndIf}
  Call ${PREFIX}KQ_VerifyPathACL
  ${If} $KQPathSafe != 1
    Goto kq_path_unsafe
  ${EndIf}
  Return
  kq_path_unsafe:
    SetErrorLevel 230
    MessageBox MB_OK|MB_ICONSTOP "O local selecionado não protege uma instalação para todos os usuários. Escolha uma pasta local com permissões administrativas. Pastas pessoais, links e locais graváveis por outros usuários não podem hospedar código elevado. Nenhum banco ou perfil foi alterado." /SD IDOK
    Quit
FunctionEnd
Function ${PREFIX}KQ_CheckInstallPath
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    SetErrorLevel 230
    Quit
  ${EndIf}
  StrCpy $INSTDIR $0
  StrLen $1 $INSTDIR
  ${If} $1 <= 3
    SetErrorLevel 230
    Quit
  ${EndIf}
  StrCpy $0 $INSTDIR 3
  StrCpy $1 $INSTDIR 2 1
  ${If} $1 != ":\"
    SetErrorLevel 230
    Quit
  ${EndIf}
  System::Call 'kernel32::GetDriveTypeW(w r0) i.r1'
  ${If} $1 != 3
  ${AndIf} $1 != 2
    SetErrorLevel 230
    Quit
  ${EndIf}
  StrCpy $KQPathWalk $INSTDIR
  Call ${PREFIX}KQ_EnsurePathTree
FunctionEnd
!macroend
