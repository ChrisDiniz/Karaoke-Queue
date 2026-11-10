#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <shlobj.h>
#include <shellapi.h>
#include <strsafe.h>
#include <node_api.h>
#include <wchar.h>
#include <math.h>
#include <string.h>

#define ADMIN_MUTEX_NAME L"Global\\com.karaoke.queue.install-admin.v1"
#define ADMIN_MUTEX_SDDL L"D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)"
#ifdef KQ_TEST_RUNTIME_MUTEX
#define RUNTIME_MUTEX_NAME L"Global\\com.karaoke.queue.test.runtime.v1"
#else
#define RUNTIME_MUTEX_NAME L"Global\\com.karaoke.queue.runtime.v1"
#endif
#define RUNTIME_MUTEX_SDDL L"D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)(A;;0x00120001;;;AU)(A;;0x00120001;;;OW)S:(ML;;NW;;;ME)"
#define INSTALLATION_DIRECTORY_SDDL L"D:P(A;OICI;0x001f01ff;;;SY)(A;OICI;0x001f01ff;;;BA)(A;OICI;0x001200a9;;;AU)"
#define INSTALLATION_FILE_SDDL L"D:AI(A;ID;0x001f01ff;;;SY)(A;ID;0x001f01ff;;;BA)(A;ID;0x001200a9;;;AU)"

typedef struct { HANDLE handle; DWORD owner_thread; } admin_gate;
static admin_gate gate = { NULL, 0 };
static admin_gate runtime_gate = { NULL, 0 };
static HANDLE initial_role_process = NULL;
#ifdef KQ_TEST_RUNTIME_MUTEX
static HANDLE test_runtime_reference = NULL;
#endif

static napi_value make_result(napi_env env, const char *status, DWORD code) {
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "status", value);
  napi_create_uint32(env, code, &value);
  napi_set_named_property(env, result, "code", value);
  return result;
}

static int current_process_is_elevated(void) {
  HANDLE token = NULL;
  TOKEN_ELEVATION elevation;
  DWORD bytes = 0;
  int elevated = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return -1;
  if (GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes)) elevated = elevation.TokenIsElevated ? 1 : 0;
  else elevated = -1;
  CloseHandle(token);
  return elevated;
}

static DWORD compare_dacl(HANDLE handle, PSECURITY_DESCRIPTOR expected) {
  PSECURITY_DESCRIPTOR actual = NULL;
  PSID owner = NULL, system_sid = NULL, admins_sid = NULL;
  LPWSTR actual_text = NULL, expected_text = NULL;
  DWORD code = GetSecurityInfo(handle, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                               &owner, NULL, NULL, NULL, &actual);
  if (code != ERROR_SUCCESS) return code;
  if (!ConvertStringSidToSidW(L"S-1-5-18", &system_sid) || !ConvertStringSidToSidW(L"S-1-5-32-544", &admins_sid)) {
    code = GetLastError();
  } else if (!owner || (!EqualSid(owner, system_sid) && !EqualSid(owner, admins_sid))) {
    code = ERROR_INVALID_OWNER;
  }
  if (code != ERROR_SUCCESS) {
    if (system_sid) LocalFree(system_sid);
    if (admins_sid) LocalFree(admins_sid);
    LocalFree(actual);
    return code;
  }
  if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(actual, SDDL_REVISION_1,
       DACL_SECURITY_INFORMATION, &actual_text, NULL) ||
      !ConvertSecurityDescriptorToStringSecurityDescriptorW(expected, SDDL_REVISION_1,
       DACL_SECURITY_INFORMATION, &expected_text, NULL)) code = GetLastError();
  else if (wcscmp(actual_text, expected_text) != 0) code = ERROR_INVALID_ACL;
  if (actual_text) LocalFree(actual_text);
  if (expected_text) LocalFree(expected_text);
  if (system_sid) LocalFree(system_sid);
  if (admins_sid) LocalFree(admins_sid);
  LocalFree(actual);
  return code;
}

/* This job is a process-tree lifetime fence, NOT the runtime mutex.
 * No breakaway or kill-on-close flags: children keep a crashed parent's fence
 * alive; a different operation may never join an existing tree. */
#ifdef KQ_TEST_RUNTIME_MUTEX
#define OPERATION_JOB_NAME L"Global\\com.karaoke.queue.test.operation.v1"
#define OPERATION_JOB_SDDL L"D:P(A;;0x001f003f;;;OW)"
#else
#define OPERATION_JOB_NAME L"Global\\com.karaoke.queue.install-operation.v1"
#define OPERATION_JOB_SDDL L"O:BAD:P(A;;0x001f003f;;;SY)(A;;0x001f003f;;;BA)"
#endif
static HANDLE operation_job = NULL;
static BOOL operation_job_delegated = FALSE;
static napi_value operation_tree_state(napi_env env, napi_callback_info info) {
  HANDLE handle = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, OPERATION_JOB_NAME);
  if (!handle) { DWORD error = GetLastError(); return make_result(env,
    error == ERROR_FILE_NOT_FOUND ? "absent" : "query_error", error == ERROR_FILE_NOT_FOUND ? 0 : error); }
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  BOOL ok = QueryInformationJobObject(handle, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL);
  DWORD error = ok ? 0 : GetLastError(); CloseHandle(handle);
  return make_result(env, !ok ? "query_error" : accounting.ActiveProcesses ? "active" : "draining", error);
}

static napi_value enter_operation_tree(napi_env env, napi_callback_info info) {
#ifndef KQ_TEST_RUNTIME_MUTEX
  if (current_process_is_elevated() != 1) return make_result(env, "not_elevated", ERROR_ACCESS_DENIED);
#endif
  if (operation_job) return make_result(env, operation_job_delegated ? "delegated" : "joined", ERROR_SUCCESS);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(OPERATION_JOB_SDDL, SDDL_REVISION_1, &descriptor, NULL))
    return make_result(env, "security_error", GetLastError());
  SECURITY_ATTRIBUTES attributes = { sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
  HANDLE handle = CreateJobObjectW(&attributes, OPERATION_JOB_NAME);
  DWORD error = GetLastError();
  if (!handle) { LocalFree(descriptor); return make_result(env, "create_error", error); }
#ifndef KQ_TEST_RUNTIME_MUTEX
  DWORD security = compare_dacl(handle, descriptor);
  if (security != ERROR_SUCCESS) { CloseHandle(handle); LocalFree(descriptor); return make_result(env, "acl_error", security); }
#endif
  LocalFree(descriptor);
  BOOL member = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), handle, &member)) {
    error = GetLastError(); CloseHandle(handle); return make_result(env, "query_error", error);
  }
  if (error == ERROR_ALREADY_EXISTS && !member) {
    CloseHandle(handle); return make_result(env, "busy", ERROR_BUSY);
  }
  if (!member && !AssignProcessToJobObject(handle, GetCurrentProcess())) {
    error = GetLastError(); CloseHandle(handle); return make_result(env, "assign_error", error);
  }
  operation_job_delegated = member;
  operation_job = handle; /* process lifetime; never detach/terminate members */
  return make_result(env, member ? "delegated" : "joined", ERROR_SUCCESS);
}

static DWORD compare_runtime_security(HANDLE handle, PSECURITY_DESCRIPTOR expected) {
  PSECURITY_DESCRIPTOR actual = NULL;
  PACL actual_dacl = NULL, expected_dacl = NULL, actual_sacl = NULL, expected_sacl = NULL;
  BOOL actual_dacl_present = FALSE, expected_dacl_present = FALSE;
  BOOL actual_sacl_present = FALSE, expected_sacl_present = FALSE;
  BOOL actual_defaulted = FALSE, expected_defaulted = FALSE;
  SECURITY_DESCRIPTOR_CONTROL actual_control = 0, expected_control = 0;
  DWORD actual_revision = 0, expected_revision = 0;
  DWORD code = GetSecurityInfo(handle, SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
      NULL, NULL, NULL, NULL, &actual);
  if (code != ERROR_SUCCESS) return code;

  if (!GetSecurityDescriptorControl(actual, &actual_control, &actual_revision) ||
      !GetSecurityDescriptorControl(expected, &expected_control, &expected_revision) ||
      !GetSecurityDescriptorDacl(actual, &actual_dacl_present, &actual_dacl, &actual_defaulted) ||
      !GetSecurityDescriptorDacl(expected, &expected_dacl_present, &expected_dacl, &expected_defaulted) ||
      !GetSecurityDescriptorSacl(actual, &actual_sacl_present, &actual_sacl, &actual_defaulted) ||
      !GetSecurityDescriptorSacl(expected, &expected_sacl_present, &expected_sacl, &expected_defaulted)) {
    code = GetLastError();
  } else if (actual_revision != expected_revision ||
      ((actual_control ^ expected_control) & SE_DACL_PROTECTED) != 0 ||
      actual_dacl_present != expected_dacl_present || actual_sacl_present != expected_sacl_present ||
      !actual_dacl || !expected_dacl || !actual_sacl || !expected_sacl) {
    code = ERROR_INVALID_ACL;
  } else {
    ACL_SIZE_INFORMATION actual_info, expected_info;
    if (!GetAclInformation(actual_dacl, &actual_info, sizeof(actual_info), AclSizeInformation) ||
        !GetAclInformation(expected_dacl, &expected_info, sizeof(expected_info), AclSizeInformation) ||
        actual_info.AceCount != expected_info.AceCount || actual_info.AceCount > 16) {
      code = ERROR_INVALID_ACL;
    } else {
      BOOL matched[16] = { FALSE };
      for (DWORD expected_index = 0; expected_index < expected_info.AceCount && code == ERROR_SUCCESS; expected_index++) {
        LPVOID expected_raw = NULL;
        if (!GetAce(expected_dacl, expected_index, &expected_raw)) { code = GetLastError(); break; }
        ACCESS_ALLOWED_ACE *expected_ace = (ACCESS_ALLOWED_ACE *)expected_raw;
        if (expected_ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE) { code = ERROR_INVALID_ACL; break; }
        PSID expected_sid = (PSID)&expected_ace->SidStart;
        BOOL found = FALSE;
        for (DWORD actual_index = 0; actual_index < actual_info.AceCount; actual_index++) {
          if (matched[actual_index]) continue;
          LPVOID actual_raw = NULL;
          if (!GetAce(actual_dacl, actual_index, &actual_raw)) { code = GetLastError(); break; }
          ACCESS_ALLOWED_ACE *actual_ace = (ACCESS_ALLOWED_ACE *)actual_raw;
          if (actual_ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
              actual_ace->Header.AceFlags == expected_ace->Header.AceFlags &&
              actual_ace->Mask == expected_ace->Mask &&
              EqualSid((PSID)&actual_ace->SidStart, expected_sid)) {
            matched[actual_index] = TRUE;
            found = TRUE;
            break;
          }
        }
        if (code == ERROR_SUCCESS && !found) code = ERROR_INVALID_ACL;
      }
    }
  }

  if (code == ERROR_SUCCESS) {
    ACL_SIZE_INFORMATION actual_info, expected_info;
    if (!GetAclInformation(actual_sacl, &actual_info, sizeof(actual_info), AclSizeInformation) ||
        !GetAclInformation(expected_sacl, &expected_info, sizeof(expected_info), AclSizeInformation) ||
        actual_info.AceCount != 1 || expected_info.AceCount != 1) {
      code = ERROR_INVALID_ACL;
    } else {
      LPVOID actual_raw = NULL, expected_raw = NULL;
      if (!GetAce(actual_sacl, 0, &actual_raw) || !GetAce(expected_sacl, 0, &expected_raw)) code = GetLastError();
      else {
        SYSTEM_MANDATORY_LABEL_ACE *actual_label = (SYSTEM_MANDATORY_LABEL_ACE *)actual_raw;
        SYSTEM_MANDATORY_LABEL_ACE *expected_label = (SYSTEM_MANDATORY_LABEL_ACE *)expected_raw;
        if (actual_label->Header.AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE ||
            expected_label->Header.AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE ||
            actual_label->Header.AceFlags != expected_label->Header.AceFlags ||
            actual_label->Mask != expected_label->Mask ||
            !EqualSid((PSID)&actual_label->SidStart, (PSID)&expected_label->SidStart)) code = ERROR_INVALID_ACL;
      }
    }
  }
  if (actual) LocalFree(actual);
  return code;
}

static napi_value is_elevated(napi_env env, napi_callback_info info) {
  napi_value value;
  int elevated;
  (void)info;
  elevated = current_process_is_elevated();
  napi_get_boolean(env, elevated == 1, &value);
  return value;
}

static int current_executable_is_in_program_files(void) {
  PWSTR program_files = NULL;
  WCHAR image[MAX_PATH * 4];
  DWORD length;
  size_t root_length;
  HRESULT hr;
  hr = SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, NULL, &program_files);
  if (FAILED(hr) || !program_files) return 0;
  length = GetModuleFileNameW(NULL, image, (DWORD)(sizeof(image) / sizeof(image[0])));
  root_length = wcslen(program_files);
  DWORD root_attributes = GetFileAttributesW(program_files);
  int matches = root_attributes != INVALID_FILE_ATTRIBUTES &&
      (root_attributes & FILE_ATTRIBUTE_DIRECTORY) && !(root_attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
      length > root_length && length < (DWORD)(sizeof(image) / sizeof(image[0])) &&
      CompareStringOrdinal(image, (int)root_length, program_files, (int)root_length, TRUE) == CSTR_EQUAL &&
      (image[root_length] == L'\\' || image[root_length] == L'/');
  if (matches) {
    WCHAR *cursor = image + root_length + 1;
    while (*cursor) {
      WCHAR *separator = wcschr(cursor, L'\\');
      if (!separator) separator = wcschr(cursor, L'/');
      if (separator) *separator = L'\0';
      DWORD attributes = GetFileAttributesW(image);
      if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { matches = 0; break; }
      if (!separator) break;
      *separator = L'\\';
      cursor = separator + 1;
    }
  }
  CoTaskMemFree(program_files);
  return matches;
}


/* Registered custom paths require the same protected-code boundary as Program
 * Files. No unprivileged owner or ACE may replace an ancestor or mutate code. */
static int privileged_install_sid(PSID sid) {
  PSID trusted = NULL;
  int result = IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
  if (!result && ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &trusted)) {
    result = EqualSid(sid, trusted); LocalFree(trusted);
  }
  return result;
}
static int safe_install_acl(const WCHAR *path, DWORD forbidden) {
  PSECURITY_DESCRIPTOR sd = NULL; PSID owner = NULL; PACL acl = NULL;
  DWORD error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &acl, NULL, &sd);
  int safe = error == ERROR_SUCCESS && owner && privileged_install_sid(owner) && acl && IsValidAcl(acl);
  if (safe) for (DWORD i = 0; i < acl->AceCount; ++i) {
    void *entry = NULL;
    if (!GetAce(acl, i, &entry)) { safe = 0; break; }
    ACE_HEADER *header = (ACE_HEADER *)entry;
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { safe = 0; break; }
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)entry;
    if ((ace->Mask & forbidden) && !privileged_install_sid(&ace->SidStart)) { safe = 0; break; }
  }
  if (sd) LocalFree(sd);
  return safe;
}
static int current_executable_in_trusted_location(void) {
  if (current_executable_is_in_program_files()) return 1; /* existing protected Windows layout */
  WCHAR installed[4096], image[4096], full[4096]; DWORD bytes = sizeof(installed);
  if (RegGetValueW(HKEY_LOCAL_MACHINE, L"Software\\7792ee38-9a49-5e2e-a032-ba1be2d8f3a5", L"InstallLocation",
      RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, NULL, installed, &bytes) != ERROR_SUCCESS) return 0;
  DWORD length = GetModuleFileNameW(NULL, image, 4096);
  DWORD normalized = GetFullPathNameW(installed, 4096, full, NULL);
  if (!length || length >= 4096 || !normalized || normalized >= 4096) return 0;
  size_t n = wcslen(full); while (n > 3 && full[n-1] == L'\\') full[--n] = 0;
  if (length <= n || CompareStringOrdinal(image, (int)n, full, (int)n, TRUE) != CSTR_EQUAL || image[n] != L'\\' ||
      _wcsicmp(image+n+1, L"Karaoke Queue.exe") != 0 || n < 3 || full[1] != L':') return 0;
  const DWORD replace_rights = GENERIC_ALL | GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD;
  const DWORD write_rights = replace_rights | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES;
  DWORD image_attributes = GetFileAttributesW(image);
  if (image_attributes == INVALID_FILE_ATTRIBUTES || (image_attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      !safe_install_acl(image, write_rights)) return 0;
  /* Check every ancestor, including the selected root. No reparse traversal. */
  WCHAR walk[4096]; wcscpy_s(walk,4096,full);
  for (;;) {
    DWORD attrs = GetFileAttributesW(walk);
    if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY) || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) ||
        !safe_install_acl(walk, _wcsicmp(walk,full)==0 ? write_rights : replace_rights)) return 0;
    size_t size=wcslen(walk); if (size<=3) break;
    WCHAR *separator=wcsrchr(walk,L'\\'); if (!separator) return 0;
    if (separator==walk+2) separator[1]=0; else *separator=0;
  }
  return 1;
}
static napi_value executable_is_in_program_files(napi_env env, napi_callback_info info) {
  napi_value value;
  (void)info;
  int matches = current_executable_in_trusted_location();
  napi_get_boolean(env, matches, &value);
  return value;
}

static int valid_operation_id(const char *value) {
  size_t index;
  if (strlen(value) != 36) return 0;
  for (index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return 0;
    } else if (!((value[index] >= '0' && value[index] <= '9') ||
                 (value[index] >= 'a' && value[index] <= 'f') ||
                 (value[index] >= 'A' && value[index] <= 'F'))) return 0;
  }
  return 1;
}

static napi_value launch_initial_role_confirmation(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  size_t argument_count = 4, operation_id_length = 0, role_length = 0, installation_id_length = 0;
  char operation_id[37], role[9], installation_id[37];
  double generation;
  WCHAR image[MAX_PATH * 4], parameters[256];
  SHELLEXECUTEINFOW execute_info;
  DWORD image_length, error;
  int elevated;

  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok || argument_count != 4 ||
      napi_get_value_string_utf8(env, arguments[0], operation_id, sizeof(operation_id), &operation_id_length) != napi_ok ||
      napi_get_value_double(env, arguments[1], &generation) != napi_ok ||
      napi_get_value_string_utf8(env, arguments[2], role, sizeof(role), &role_length) != napi_ok ||
      napi_get_value_string_utf8(env, arguments[3], installation_id, sizeof(installation_id), &installation_id_length) != napi_ok) {
    return make_result(env, "arguments_invalid", ERROR_INVALID_PARAMETER);
  }
  if (installation_id_length != 36 || !valid_operation_id(installation_id) || operation_id_length != 36 || !valid_operation_id(operation_id) || !isfinite(generation) ||
      generation < 0 || generation > 9007199254740991.0 || floor(generation) != generation ||
      !((role_length == 6 && strcmp(role, "player") == 0) || (role_length == 8 && strcmp(role, "combined") == 0))) {
    return make_result(env, "arguments_invalid", ERROR_INVALID_PARAMETER);
  }
  if (initial_role_process) return make_result(env, "busy", ERROR_BUSY);
  elevated = current_process_is_elevated();
  if (elevated != 0) return make_result(env, "caller_not_standard", elevated < 0 ? ERROR_ACCESS_DENIED : ERROR_ELEVATION_REQUIRED);
  if (!current_executable_in_trusted_location()) return make_result(env, "image_untrusted", ERROR_ACCESS_DENIED);
  image_length = GetModuleFileNameW(NULL, image, (DWORD)(sizeof(image) / sizeof(image[0])));
  if (!image_length || image_length >= (DWORD)(sizeof(image) / sizeof(image[0]))) {
    return make_result(env, "image_path_error", image_length ? ERROR_INSUFFICIENT_BUFFER : GetLastError());
  }
  WCHAR operation_id_w[37], role_w[9], installation_id_w[37];
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, installation_id, -1, installation_id_w, 37) != 37 ||
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, operation_id, -1, operation_id_w, 37) != 37 ||
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, role, -1, role_w, 9) <= 0 ||
      FAILED(StringCchPrintfW(parameters, sizeof(parameters) / sizeof(parameters[0]),
        L"--kq-install-admin confirm-initial --operation-id %ls --expected-generation %.0f --role %ls --installation-id %ls",
        operation_id_w, generation, role_w, installation_id_w))) {
    return make_result(env, "arguments_invalid", ERROR_INVALID_PARAMETER);
  }

  ZeroMemory(&execute_info, sizeof(execute_info));
  execute_info.cbSize = sizeof(execute_info);
  execute_info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  execute_info.lpVerb = L"runas";
  execute_info.lpFile = image;
  execute_info.lpParameters = parameters;
  execute_info.nShow = SW_HIDE;
  if (!ShellExecuteExW(&execute_info)) {
    error = GetLastError();
    return make_result(env, error == ERROR_CANCELLED ? "cancelled" : "launch_error", error);
  }
  if (!execute_info.hProcess) return make_result(env, "process_handle_unavailable", ERROR_INVALID_HANDLE);
  initial_role_process = execute_info.hProcess;
  return make_result(env, "started", ERROR_SUCCESS);
}

static napi_value initial_role_confirmation_status(napi_env env, napi_callback_info info) {
  DWORD wait, exit_code = STILL_ACTIVE;
  napi_value result, value;
  (void)info;
  if (!initial_role_process) return make_result(env, "idle", ERROR_INVALID_HANDLE);
  wait = WaitForSingleObject(initial_role_process, 0);
  if (wait == WAIT_TIMEOUT) return make_result(env, "pending", ERROR_SUCCESS);
  if (wait != WAIT_OBJECT_0) {
    DWORD error = GetLastError();
    CloseHandle(initial_role_process);
    initial_role_process = NULL;
    return make_result(env, "wait_error", error);
  }
  if (!GetExitCodeProcess(initial_role_process, &exit_code)) {
    DWORD error = GetLastError();
    CloseHandle(initial_role_process);
    initial_role_process = NULL;
    return make_result(env, "exit_code_error", error);
  }
  CloseHandle(initial_role_process);
  initial_role_process = NULL;
  result = make_result(env, "completed", ERROR_SUCCESS);
  napi_create_uint32(env, exit_code, &value);
  napi_set_named_property(env, result, "exitCode", value);
  return result;
}

static void cleanup_initial_role_process(void *data) {
  (void)data;
  if (initial_role_process) CloseHandle(initial_role_process);
  initial_role_process = NULL;
}

static napi_value program_data_directory(napi_env env, napi_callback_info info) {
  PWSTR known_folder = NULL;
  WCHAR *combined = NULL;
  napi_value value;
  HRESULT hr;
  (void)info;
  hr = SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, NULL, &known_folder);
  if (FAILED(hr) || !known_folder) return make_result(env, "known_folder_error", (DWORD)hr);
  DWORD root_attributes = GetFileAttributesW(known_folder);
  if (root_attributes == INVALID_FILE_ATTRIBUTES || !(root_attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (root_attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    DWORD root_error = root_attributes == INVALID_FILE_ATTRIBUTES ? GetLastError() : ERROR_INVALID_REPARSE_DATA;
    CoTaskMemFree(known_folder);
    return make_result(env, "program_data_path_invalid", root_error);
  }
  size_t length = wcslen(known_folder) + 1;
  combined = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, length * sizeof(WCHAR));
  if (!combined) { CoTaskMemFree(known_folder); return make_result(env, "allocation_error", ERROR_NOT_ENOUGH_MEMORY); }
  if (FAILED(StringCchCopyW(combined, length, known_folder))) {
    HeapFree(GetProcessHeap(), 0, combined); CoTaskMemFree(known_folder);
    return make_result(env, "path_error", ERROR_INSUFFICIENT_BUFFER);
  }
  napi_create_string_utf16(env, (const char16_t *)combined, wcslen(combined), &value);
  HeapFree(GetProcessHeap(), 0, combined);
  CoTaskMemFree(known_folder);
  return value;
}

static napi_value known_folder_directory(napi_env env, const KNOWNFOLDERID *folder_id) {
  PWSTR known_folder = NULL;
  DWORD attributes;
  HRESULT hr = SHGetKnownFolderPath(folder_id, KF_FLAG_DEFAULT, NULL, &known_folder);
  if (FAILED(hr) || !known_folder) return make_result(env, "known_folder_error", (DWORD)hr);
  attributes = GetFileAttributesW(known_folder);
  if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    DWORD error = attributes == INVALID_FILE_ATTRIBUTES ? GetLastError() : ERROR_INVALID_REPARSE_DATA;
    CoTaskMemFree(known_folder);
    return make_result(env, "known_folder_path_invalid", error);
  }
  napi_value value;
  napi_status status = napi_create_string_utf16(env, (const char16_t *)known_folder, wcslen(known_folder), &value);
  CoTaskMemFree(known_folder);
  if (status != napi_ok) return make_result(env, "allocation_error", ERROR_NOT_ENOUGH_MEMORY);
  return value;
}

static napi_value common_programs_directory(napi_env env, napi_callback_info info) {
  (void)info;
  return known_folder_directory(env, &FOLDERID_CommonPrograms);
}

static napi_value public_desktop_directory(napi_env env, napi_callback_info info) {
  (void)info;
  return known_folder_directory(env, &FOLDERID_PublicDesktop);
}

static napi_value verify_installation_directory(napi_env env, napi_callback_info info) {
  PWSTR known_folder = NULL;
  WCHAR *combined = NULL;
  PSECURITY_DESCRIPTOR expected = NULL;
  PSID owner = NULL, system_sid = NULL, admins_sid = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR actual = NULL;
  DWORD code = ERROR_SUCCESS;
  HRESULT hr;
  DWORD attributes;
  napi_value result, ok;
  (void)info;

  hr = SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, NULL, &known_folder);
  if (FAILED(hr) || !known_folder) return make_result(env, "known_folder_error", (DWORD)hr);
  DWORD root_attributes = GetFileAttributesW(known_folder);
  if (root_attributes == INVALID_FILE_ATTRIBUTES || !(root_attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (root_attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    DWORD root_error = root_attributes == INVALID_FILE_ATTRIBUTES ? GetLastError() : ERROR_INVALID_REPARSE_DATA;
    CoTaskMemFree(known_folder);
    return make_result(env, "program_data_path_invalid", root_error);
  }
  size_t length = wcslen(known_folder) + wcslen(L"\\KaraokeQueue") + 1;
  combined = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, length * sizeof(WCHAR));
  if (!combined) code = ERROR_NOT_ENOUGH_MEMORY;
  if (code == ERROR_SUCCESS && (FAILED(StringCchCopyW(combined, length, known_folder)) ||
      FAILED(StringCchCatW(combined, length, L"\\KaraokeQueue")))) code = ERROR_INSUFFICIENT_BUFFER;
  if (code == ERROR_SUCCESS) {
    attributes = GetFileAttributesW(combined);
    if (attributes == INVALID_FILE_ATTRIBUTES) code = GetLastError();
    else if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) code = ERROR_INVALID_REPARSE_DATA;
  }
  if (code == ERROR_SUCCESS && !ConvertStringSecurityDescriptorToSecurityDescriptorW(INSTALLATION_DIRECTORY_SDDL, SDDL_REVISION_1, &expected, NULL)) code = GetLastError();
  if (code == ERROR_SUCCESS) code = GetNamedSecurityInfoW(combined, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &actual);
  if (code == ERROR_SUCCESS && !ConvertStringSidToSidW(L"S-1-5-18", &system_sid)) code = GetLastError();
  if (code == ERROR_SUCCESS && !ConvertStringSidToSidW(L"S-1-5-32-544", &admins_sid)) code = GetLastError();
  if (code == ERROR_SUCCESS && (!owner || (!EqualSid(owner, system_sid) && !EqualSid(owner, admins_sid)))) code = ERROR_INVALID_OWNER;
  if (code == ERROR_SUCCESS && !IsValidSecurityDescriptor(expected)) code = ERROR_INVALID_SECURITY_DESCR;
  if (code == ERROR_SUCCESS) {
    LPWSTR actual_text = NULL, expected_text = NULL;
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(actual, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &actual_text, NULL) ||
        !ConvertSecurityDescriptorToStringSecurityDescriptorW(expected, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &expected_text, NULL)) code = GetLastError();
    else if (wcscmp(actual_text, expected_text) != 0) code = ERROR_INVALID_ACL;
    if (actual_text) LocalFree(actual_text);
    if (expected_text) LocalFree(expected_text);
  }
  if (known_folder) CoTaskMemFree(known_folder);
  if (combined) HeapFree(GetProcessHeap(), 0, combined);
  if (expected) LocalFree(expected);
  if (system_sid) LocalFree(system_sid);
  if (admins_sid) LocalFree(admins_sid);
  if (actual) LocalFree(actual);
  napi_create_object(env, &result);
  napi_get_boolean(env, code == ERROR_SUCCESS, &ok);
  napi_set_named_property(env, result, "ok", ok);
  napi_create_uint32(env, code, &ok);
  napi_set_named_property(env, result, "code", ok);
  return result;
}

/* AI is propagation bookkeeping, not an ACE or a grant. CreateFile and
 * atomic replacement can omit it on an otherwise identical inherited DACL.
 * Normalize only this bit in the private readback descriptors. Keep P, ACE
 * type/order/masks/SIDs and ID flags exact; the owner check remains separate. */
static DWORD compare_manifest_dacl(PSECURITY_DESCRIPTOR actual, PSECURITY_DESCRIPTOR expected) {
  LPWSTR actual_text = NULL, expected_text = NULL;
  DWORD code = ERROR_SUCCESS;
  if (!SetSecurityDescriptorControl(actual, SE_DACL_AUTO_INHERITED, 0) ||
      !SetSecurityDescriptorControl(expected, SE_DACL_AUTO_INHERITED, 0)) return GetLastError();
  if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(actual, SDDL_REVISION_1,
      DACL_SECURITY_INFORMATION, &actual_text, NULL) ||
      !ConvertSecurityDescriptorToStringSecurityDescriptorW(expected, SDDL_REVISION_1,
      DACL_SECURITY_INFORMATION, &expected_text, NULL)) code = GetLastError();
  else if (wcscmp(actual_text, expected_text) != 0) code = ERROR_INVALID_ACL;
  if (actual_text) LocalFree(actual_text);
  if (expected_text) LocalFree(expected_text);
  return code;
}

#ifdef KQ_TEST_RUNTIME_MUTEX
static napi_value test_manifest_dacl(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0; napi_value args[1]; WCHAR text[4096];
  PSECURITY_DESCRIPTOR actual = NULL, expected = NULL;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1 || napi_get_value_string_utf16(env, args[0], NULL, 0, &length) != napi_ok || length >= 4096 ||
      napi_get_value_string_utf16(env, args[0], (char16_t *)text, 4096, &length) != napi_ok)
    return make_result(env, "invalid", ERROR_INVALID_PARAMETER);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, &actual, NULL)) return make_result(env, "invalid", GetLastError());
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(INSTALLATION_FILE_SDDL, 1, &expected, NULL)) {
    DWORD error = GetLastError(); LocalFree(actual); return make_result(env, "invalid", error);
  }
  DWORD code = compare_manifest_dacl(actual, expected);
  LocalFree(actual); LocalFree(expected);
  return make_result(env, code == 0 ? "matched" : "rejected", code);
}
#endif

static napi_value verify_installation_manifest(napi_env env, napi_callback_info info) {
  PWSTR known_folder = NULL;
  WCHAR *manifest_path = NULL;
  PSID owner = NULL, system_sid = NULL, admins_sid = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR actual = NULL, expected = NULL;
  DWORD code = ERROR_SUCCESS, attributes;
  HRESULT hr;
  napi_value result, ok;
  (void)info;

  hr = SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, NULL, &known_folder);
  if (FAILED(hr) || !known_folder) return make_result(env, "known_folder_error", (DWORD)hr);
  DWORD root_attributes = GetFileAttributesW(known_folder);
  if (root_attributes == INVALID_FILE_ATTRIBUTES || !(root_attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (root_attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    DWORD root_error = root_attributes == INVALID_FILE_ATTRIBUTES ? GetLastError() : ERROR_INVALID_REPARSE_DATA;
    CoTaskMemFree(known_folder);
    return make_result(env, "program_data_path_invalid", root_error);
  }
  size_t length = wcslen(known_folder) + wcslen(L"\\KaraokeQueue\\installation.json") + 1;
  manifest_path = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, length * sizeof(WCHAR));
  if (!manifest_path) code = ERROR_NOT_ENOUGH_MEMORY;
  if (code == ERROR_SUCCESS && (FAILED(StringCchCopyW(manifest_path, length, known_folder)) ||
      FAILED(StringCchCatW(manifest_path, length, L"\\KaraokeQueue\\installation.json")))) code = ERROR_INSUFFICIENT_BUFFER;
  if (code == ERROR_SUCCESS) {
    attributes = GetFileAttributesW(manifest_path);
    if (attributes == INVALID_FILE_ATTRIBUTES) code = GetLastError();
    else if ((attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) code = ERROR_INVALID_REPARSE_DATA;
  }
  if (code == ERROR_SUCCESS && !ConvertStringSecurityDescriptorToSecurityDescriptorW(INSTALLATION_FILE_SDDL, SDDL_REVISION_1, &expected, NULL)) code = GetLastError();
  if (code == ERROR_SUCCESS) code = GetNamedSecurityInfoW(manifest_path, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &actual);
  if (code == ERROR_SUCCESS && !ConvertStringSidToSidW(L"S-1-5-18", &system_sid)) code = GetLastError();
  if (code == ERROR_SUCCESS && !ConvertStringSidToSidW(L"S-1-5-32-544", &admins_sid)) code = GetLastError();
  if (code == ERROR_SUCCESS && (!owner || (!EqualSid(owner, system_sid) && !EqualSid(owner, admins_sid)))) code = ERROR_INVALID_OWNER;
  if (code == ERROR_SUCCESS && !IsValidSecurityDescriptor(expected)) code = ERROR_INVALID_SECURITY_DESCR;
  if (code == ERROR_SUCCESS) code = compare_manifest_dacl(actual, expected);
  if (known_folder) CoTaskMemFree(known_folder);
  if (manifest_path) HeapFree(GetProcessHeap(), 0, manifest_path);
  if (expected) LocalFree(expected);
  if (system_sid) LocalFree(system_sid);
  if (admins_sid) LocalFree(admins_sid);
  if (actual) LocalFree(actual);
  napi_create_object(env, &result);
  napi_get_boolean(env, code == ERROR_SUCCESS, &ok);
  napi_set_named_property(env, result, "ok", ok);
  napi_create_uint32(env, code, &ok);
  napi_set_named_property(env, result, "code", ok);
  return result;
}

static napi_value acquire_administrative(napi_env env, napi_callback_info info) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), NULL, FALSE };
  HANDLE handle;
  DWORD error, wait, acl_code;
  (void)info;
  if (gate.handle) return make_result(env, "recursive_blocked", ERROR_POSSIBLE_DEADLOCK);
  if (current_process_is_elevated() != 1) return make_result(env, "not_elevated", ERROR_ACCESS_DENIED);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(ADMIN_MUTEX_SDDL, SDDL_REVISION_1, &descriptor, NULL))
    return make_result(env, "sddl_error", GetLastError());
  attributes.lpSecurityDescriptor = descriptor;
  handle = CreateMutexExW(&attributes, ADMIN_MUTEX_NAME, 0, SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL);
  error = GetLastError();
  LocalFree(descriptor);
  if (!handle) return make_result(env, "create_error", error);
  PSECURITY_DESCRIPTOR expected = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(ADMIN_MUTEX_SDDL, SDDL_REVISION_1, &expected, NULL)) {
    error = GetLastError(); CloseHandle(handle); return make_result(env, "sddl_error", error);
  }
  acl_code = compare_dacl(handle, expected);
  LocalFree(expected);
  if (acl_code != ERROR_SUCCESS) { CloseHandle(handle); return make_result(env, "acl_error", acl_code); }
  wait = WaitForSingleObject(handle, 0);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) {
    CloseHandle(handle);
    return make_result(env, wait == WAIT_TIMEOUT ? "busy" : "wait_error", wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError());
  }
  gate.handle = handle;
  gate.owner_thread = GetCurrentThreadId();
  return make_result(env, wait == WAIT_ABANDONED ? "abandoned" : "acquired", error);
}

static napi_value release_owned(napi_env env, napi_callback_info info) {
  DWORD error;
  (void)info;
  if (!gate.handle) return make_result(env, "not_owned", ERROR_INVALID_HANDLE);
  if (gate.owner_thread != GetCurrentThreadId()) return make_result(env, "wrong_thread", ERROR_INVALID_THREAD_ID);
  if (!ReleaseMutex(gate.handle)) return make_result(env, "release_error", GetLastError());
  if (!CloseHandle(gate.handle)) { error = GetLastError(); gate.handle = NULL; gate.owner_thread = 0; return make_result(env, "close_error", error); }
  gate.handle = NULL; gate.owner_thread = 0;
  return make_result(env, "released", ERROR_SUCCESS);
}

static napi_value acquire_runtime(napi_env env, napi_callback_info info) {
  PSECURITY_DESCRIPTOR descriptor = NULL, expected = NULL;
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), NULL, FALSE };
  HANDLE handle;
  DWORD error, wait, acl_code;
  (void)info;
  if (runtime_gate.handle) return make_result(env, "recursive_blocked", ERROR_POSSIBLE_DEADLOCK);
  if (current_process_is_elevated() < 0) return make_result(env, "token_error", ERROR_ACCESS_DENIED);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(RUNTIME_MUTEX_SDDL, SDDL_REVISION_1, &descriptor, NULL))
    return make_result(env, "sddl_error", GetLastError());
  attributes.lpSecurityDescriptor = descriptor;
  handle = CreateMutexExW(&attributes, RUNTIME_MUTEX_NAME, 0,
      SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL);
  error = GetLastError();
  LocalFree(descriptor);
  if (!handle) return make_result(env, "create_error", error);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(RUNTIME_MUTEX_SDDL, SDDL_REVISION_1, &expected, NULL)) {
    error = GetLastError(); CloseHandle(handle); return make_result(env, "sddl_error", error);
  }
  acl_code = compare_runtime_security(handle, expected);
  LocalFree(expected);
  if (acl_code != ERROR_SUCCESS) { CloseHandle(handle); return make_result(env, "acl_error", acl_code); }
  wait = WaitForSingleObject(handle, 0);
  if (wait == WAIT_ABANDONED) {
    if (!ReleaseMutex(handle)) { error = GetLastError(); CloseHandle(handle); return make_result(env, "abandoned_release_error", error); }
    CloseHandle(handle);
    return make_result(env, "abandoned", ERROR_ABANDONED_WAIT_0);
  }
  if (wait != WAIT_OBJECT_0) {
    error = wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
    CloseHandle(handle);
    return make_result(env, wait == WAIT_TIMEOUT ? "busy" : "wait_error", error);
  }
  runtime_gate.handle = handle;
  runtime_gate.owner_thread = GetCurrentThreadId();
  return make_result(env, "acquired", ERROR_SUCCESS);
}

static napi_value release_runtime(napi_env env, napi_callback_info info) {
  DWORD error;
  (void)info;
  if (!runtime_gate.handle) return make_result(env, "not_owned", ERROR_INVALID_HANDLE);
  if (runtime_gate.owner_thread != GetCurrentThreadId()) return make_result(env, "wrong_thread", ERROR_INVALID_THREAD_ID);
  if (!ReleaseMutex(runtime_gate.handle)) return make_result(env, "release_error", GetLastError());
  if (!CloseHandle(runtime_gate.handle)) {
    error = GetLastError(); runtime_gate.handle = NULL; runtime_gate.owner_thread = 0;
    return make_result(env, "close_error", error);
  }
  runtime_gate.handle = NULL; runtime_gate.owner_thread = 0;
  return make_result(env, "released", ERROR_SUCCESS);
}

#ifdef KQ_TEST_RUNTIME_MUTEX
static napi_value open_test_runtime_reference(napi_env env, napi_callback_info info) {
  PSECURITY_DESCRIPTOR descriptor = NULL, expected = NULL;
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), NULL, FALSE };
  HANDLE handle;
  DWORD error, acl_code;
  (void)info;
  if (test_runtime_reference) return make_result(env, "already_open", ERROR_ALREADY_EXISTS);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(RUNTIME_MUTEX_SDDL, SDDL_REVISION_1, &descriptor, NULL))
    return make_result(env, "sddl_error", GetLastError());
  attributes.lpSecurityDescriptor = descriptor;
  handle = CreateMutexExW(&attributes, RUNTIME_MUTEX_NAME, 0,
      SYNCHRONIZE | MUTEX_MODIFY_STATE | READ_CONTROL);
  error = GetLastError();
  LocalFree(descriptor);
  if (!handle) return make_result(env, "create_error", error);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(RUNTIME_MUTEX_SDDL, SDDL_REVISION_1, &expected, NULL)) {
    error = GetLastError(); CloseHandle(handle); return make_result(env, "sddl_error", error);
  }
  acl_code = compare_runtime_security(handle, expected);
  LocalFree(expected);
  if (acl_code != ERROR_SUCCESS) { CloseHandle(handle); return make_result(env, "acl_error", acl_code); }
  test_runtime_reference = handle;
  return make_result(env, "opened", ERROR_SUCCESS);
}

static napi_value close_test_runtime_reference(napi_env env, napi_callback_info info) {
  DWORD error;
  (void)info;
  if (!test_runtime_reference) return make_result(env, "not_open", ERROR_INVALID_HANDLE);
  if (!CloseHandle(test_runtime_reference)) { error = GetLastError(); test_runtime_reference = NULL; return make_result(env, "close_error", error); }
  test_runtime_reference = NULL;
  return make_result(env, "closed", ERROR_SUCCESS);
}
#endif

#ifdef KQ_TEST_RUNTIME_MUTEX
static HANDLE test_process_reference = NULL;
static napi_value open_test_process(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; uint32_t pid = 0;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1 || napi_get_value_uint32(env, args[0], &pid) != napi_ok || !pid || test_process_reference)
    return make_result(env, "invalid", ERROR_INVALID_PARAMETER);
  test_process_reference = OpenProcess(SYNCHRONIZE, FALSE, pid);
  return make_result(env, test_process_reference ? "opened" : "error", test_process_reference ? 0 : GetLastError());
}
static napi_value wait_test_process(napi_env env, napi_callback_info info) {
  if (!test_process_reference) return make_result(env, "invalid", ERROR_INVALID_HANDLE);
  DWORD result = WaitForSingleObject(test_process_reference, 30000);
  CloseHandle(test_process_reference); test_process_reference = NULL;
  return make_result(env, result == WAIT_OBJECT_0 ? "exited" : "error", result);
}
#endif

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"installationOperationState", NULL, operation_tree_state, NULL, NULL, NULL, napi_default, NULL},
    {"enterInstallationOperation", NULL, enter_operation_tree, NULL, NULL, NULL, napi_default, NULL},
    {"isProcessElevated", NULL, is_elevated, NULL, NULL, NULL, napi_default, NULL},
    {"isExecutableInTrustedLocation", NULL, executable_is_in_program_files, NULL, NULL, NULL, napi_default, NULL},
    {"getProgramDataDirectory", NULL, program_data_directory, NULL, NULL, NULL, napi_default, NULL},
    {"getCommonProgramsDirectory", NULL, common_programs_directory, NULL, NULL, NULL, napi_default, NULL},
    {"getPublicDesktopDirectory", NULL, public_desktop_directory, NULL, NULL, NULL, napi_default, NULL},
    {"verifyInstallationDirectory", NULL, verify_installation_directory, NULL, NULL, NULL, napi_default, NULL},
    {"verifyInstallationManifest", NULL, verify_installation_manifest, NULL, NULL, NULL, napi_default, NULL},
    {"acquireAdministrative", NULL, acquire_administrative, NULL, NULL, NULL, napi_default, NULL},
    {"releaseOwned", NULL, release_owned, NULL, NULL, NULL, napi_default, NULL},
    {"acquireRuntime", NULL, acquire_runtime, NULL, NULL, NULL, napi_default, NULL},
    {"releaseRuntime", NULL, release_runtime, NULL, NULL, NULL, napi_default, NULL},
    {"launchInitialRoleConfirmation", NULL, launch_initial_role_confirmation, NULL, NULL, NULL, napi_default, NULL},
    {"getInitialRoleConfirmationStatus", NULL, initial_role_confirmation_status, NULL, NULL, NULL, napi_default, NULL}
#ifdef KQ_TEST_RUNTIME_MUTEX
    ,{"testManifestDacl", NULL, test_manifest_dacl, NULL, NULL, NULL, napi_default, NULL}
    ,{"openTestProcessReference", NULL, open_test_process, NULL, NULL, NULL, napi_default, NULL}
    ,{"waitTestProcessExit", NULL, wait_test_process, NULL, NULL, NULL, napi_default, NULL}
    ,{"openTestRuntimeReference", NULL, open_test_runtime_reference, NULL, NULL, NULL, napi_default, NULL}
    ,{"closeTestRuntimeReference", NULL, close_test_runtime_reference, NULL, NULL, NULL, napi_default, NULL}
#endif
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  napi_add_env_cleanup_hook(env, cleanup_initial_role_process, NULL);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
