param([Parameter(Mandatory=$true)][string]$FixturePath, [switch]$Synthetic)
$ErrorActionPreference='Stop'
if ($Synthetic) {
  $parent=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($FixturePath)).TrimEnd('\')
  if ($parent -ine [IO.Path]::GetTempPath().TrimEnd('\') -or
      [IO.Path]::GetFileName($FixturePath) -notmatch '^kq-protected-fixture-[a-f0-9-]+$') {
    throw 'Synthetic ACL fixture must be an exclusive temp directory'
  }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $sddl="O:${sid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;$sid)"
} else {
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Protected product fixture is restricted to disposable GitHub-hosted Windows'
  }
  $expected=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'KaraokeQueue'
  if ([IO.Path]::GetFullPath($FixturePath) -ine [IO.Path]::GetFullPath($expected)) { throw 'Unexpected control fixture path' }
  $sddl='O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)'
}
if (Test-Path -LiteralPath $FixturePath) { throw 'Control fixture already exists; content preserved' }
# Use the same creation-time SECURITY_ATTRIBUTES/SDDL as NSIS. icacls edits
# reorder ACEs and add AUTO_INHERITED metadata, violating the canonical contract.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class KqSmokeControl {
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public uint length; public IntPtr descriptor; public int inherit; }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value,uint rev,out IntPtr sd,IntPtr size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref Attributes attributes);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string path,uint type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl,out IntPtr sd);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd,uint rev,uint info,out IntPtr text,IntPtr size);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static string Text(IntPtr sd) { IntPtr text; if(!ConvertSecurityDescriptorToStringSecurityDescriptor(sd,1,5,out text,IntPtr.Zero)) throw new Win32Exception(); try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);} }
 public static void Create(string path,string sddl) {
  IntPtr expected;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out expected,IntPtr.Zero)) throw new Win32Exception();
  try {
   var attributes=new Attributes {length=(uint)Marshal.SizeOf(typeof(Attributes)),descriptor=expected,inherit=0};
   if(!CreateDirectory(path,ref attributes))throw new Win32Exception();
   IntPtr actual;
   uint error=GetNamedSecurityInfo(path,1,5,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out actual);
   if(error!=0)throw new Win32Exception((int)error);
   try { if(Text(expected)!=Text(actual))throw new InvalidOperationException("Native control ACL/owner mismatch"); }
   finally {LocalFree(actual);}
  } finally {LocalFree(expected);}
 }
}
'@
[KqSmokeControl]::Create($FixturePath,$sddl)
Write-Output 'CANONICAL CONTROL FIXTURE PASS'
