; Process-tree admission. Handles and membership live until process exit;
; no thread-owned mutex is transferred, and no member is ever killed.
!macro KQ_OPERATION_TREE PREFIX
Var KQOperationJob
Var KQOperationDelegated
Function ${PREFIX}KQ_EnterOperationTree
  StrCpy $KQOperationDelegated "0"
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "O:BAD:P(A;;0x001f003f;;;SY)(A;;0x001f003f;;;BA)", i 1, *p .r0, p 0) i.r1'
  ${If} $1 == 0
    Goto kq_operation_error
  ${EndIf}
  System::Call '*(i 12, p r0, i 0) p.r2'
  System::Call 'kernel32::CreateJobObjectW(p r2, w "Global\com.karaoke.queue.install-operation.v1") p.r3 ?e'
  Pop $R9
  System::Free $2
  ${If} $3 == 0
    System::Call 'kernel32::LocalFree(p r0) p.r1'
    Goto kq_operation_error
  ${EndIf}
  StrCpy $KQOperationJob $3
  ; Compare owner + protected DACL against the same descriptor, not a string
  ; whose numeric access-mask formatting depends on the Windows version.
  System::Call 'advapi32::GetSecurityInfo(p r3, i 6, i 5, p 0, p 0, p 0, p 0, *p .r4) i.r1'
  ${If} $1 != 0
    System::Call 'kernel32::LocalFree(p r0) p.r1'
    Goto kq_operation_error
  ${EndIf}
  System::Call 'advapi32::ConvertSecurityDescriptorToStringSecurityDescriptorW(p r0, i 1, i 5, *p .r5, p 0) i.r1'
  ${If} $1 == 0
    System::Call 'kernel32::LocalFree(p r0) p.r1'
    System::Call 'kernel32::LocalFree(p r4) p.r1'
    Goto kq_operation_error
  ${EndIf}
  System::Call 'advapi32::ConvertSecurityDescriptorToStringSecurityDescriptorW(p r4, i 1, i 5, *p .r6, p 0) i.r1'
  ${If} $1 == 0
    System::Call 'kernel32::LocalFree(p r0) p.r1'
    System::Call 'kernel32::LocalFree(p r4) p.r1'
    System::Call 'kernel32::LocalFree(p r5) p.r1'
    Goto kq_operation_error
  ${EndIf}
  System::Call 'kernel32::lstrcmpW(p r5, p r6) i.r7'
  System::Call 'kernel32::LocalFree(p r0) p.r1'
  System::Call 'kernel32::LocalFree(p r4) p.r1'
  System::Call 'kernel32::LocalFree(p r5) p.r1'
  System::Call 'kernel32::LocalFree(p r6) p.r1'
  ${If} $7 != 0
    Goto kq_operation_error
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'kernel32::IsProcessInJob(p r0, p $KQOperationJob, *i .r2) i.r1'
  ${If} $1 == 0
    Goto kq_operation_error
  ${EndIf}
  ${If} $R9 == 183
    ${If} $2 != 1
      Goto kq_operation_error
    ${EndIf}
    StrCpy $KQOperationDelegated "1"
  ${Else}
    System::Call 'kernel32::AssignProcessToJobObject(p $KQOperationJob, p r0) i.r1'
    ${If} $1 == 0
      Goto kq_operation_error
    ${EndIf}
  ${EndIf}
  Return
  kq_operation_error:
    MessageBox MB_OK|MB_ICONSTOP "A instalação está ocupada ou a coordenação Windows não pôde ser validada. Feche a operação anterior e tente novamente. Nenhum processo será encerrado à força." /SD IDOK
    SetErrorLevel 2
    Quit
FunctionEnd
!macroend
