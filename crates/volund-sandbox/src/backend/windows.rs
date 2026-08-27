use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, WAIT_TIMEOUT},
    Security::{
        Authorization::{
            GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
            GRANT_ACCESS, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
            TRUSTEE_W,
        },
        CreateRestrictedToken, FreeSid,
        Isolation::{
            CreateAppContainerProfile, DeleteAppContainerProfile,
            DeriveAppContainerSidFromAppContainerName,
        },
        ACL, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, NO_INHERITANCE,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        TOKEN_ALL_ACCESS,
    },
    Storage::FileSystem::{
        DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_TRAVERSE,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        },
        Threading::{
            CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
            GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken,
            ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
            PROCESS_QUERY_LIMITED_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            STARTUPINFOEXW,
        },
    },
};

const TIER_ONE_PROCESS_MEMORY_LIMIT: usize = 512 * 1024 * 1024;

pub fn probe() -> ProbeInfo {
    ProbeInfo {
        platform: "windows".into(),
        arch: std::env::consts::ARCH.into(),
        libc: None,
        os_version: std::env::var("OS").unwrap_or_default(),
        tier: SandboxTier::Partial,
        features: BTreeMap::from([
            ("job_object".into(), true.into()),
            ("restricted_token".into(), true.into()),
            ("appcontainer".into(), true.into()),
            ("acl_rollback".into(), true.into()),
            ("orphan_cleanup".into(), true.into()),
        ]),
        known_limitations: vec![
            "Windows Tier 2 isolates filesystem access with AppContainer ACLs, but cannot enforce per-host network allowlists".into(),
            "Windows Tier 3 WFP network filtering is intentionally not implemented in L2".into(),
        ],
    }
}

pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    // Resolve before creating the process. Tier 3 consumes only these pinned
    // tuples, never a second DNS answer after the policy is installed.
    let allowlist = request.permissions.net.allowlist()?;
    let _pinned_endpoints = crate::network::resolve_allowlist(allowlist)?;
    let started = Instant::now();
    let output_dir = std::env::temp_dir().join(format!(
        "volund-sandbox-{}-{}",
        std::process::id(),
        started.elapsed().as_nanos()
    ));
    std::fs::create_dir(&output_dir)
        .map_err(|error| format!("create output directory: {error}"))?;
    let stdout_path = output_dir.join("stdout.txt");
    let stderr_path = output_dir.join("stderr.txt");
    let command_path = output_dir.join("command.cmd");
    std::fs::write(
        &command_path,
        format!("@echo off\r\n{}\r\n", request.command),
    )
    .map_err(|error| format!("write command script: {error}"))?;
    let result = unsafe { run_restricted(request, &output_dir, &stdout_path, &stderr_path) };
    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&output_dir);
    let exit_code = result?;
    Ok(ExecResult {
        stdout,
        stderr,
        exit_code,
        duration_ms: started.elapsed().as_millis(),
        sandbox_tier: SandboxTier::Partial,
        sandbox_violations: vec![],
    })
}

unsafe fn run_restricted(
    request: &ExecRequest,
    output_dir: &Path,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<i32, String> {
    cleanup_orphaned_acls()?;
    let appcontainer = AppContainerLease::create(request, output_dir)?;
    let mut process_token: HANDLE = null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut process_token) == 0 {
        return Err(last_error("open process token"));
    }
    let process_token = OwnedHandle(process_token);

    let mut restricted_token: HANDLE = null_mut();
    if CreateRestrictedToken(
        process_token.0,
        DISABLE_MAX_PRIVILEGE,
        0,
        null(),
        0,
        null(),
        0,
        null(),
        &mut restricted_token,
    ) == 0
    {
        return Err(last_error("create restricted token"));
    }
    let restricted_token = OwnedHandle(restricted_token);

    let job = CreateJobObjectW(null(), null());
    if job.is_null() {
        return Err(last_error("create Job Object"));
    }
    let job = OwnedHandle(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    // The command processor and one direct child may run; a grandchild is
    // rejected by the Job Object and covered by the native escape suite.
    limits.BasicLimitInformation.ActiveProcessLimit = 2;
    limits.ProcessMemoryLimit = TIER_ONE_PROCESS_MEMORY_LIMIT;
    if SetInformationJobObject(
        job.0,
        JobObjectExtendedLimitInformation,
        &limits as *const _ as *const c_void,
        std::mem::size_of_val(&limits) as u32,
    ) == 0
    {
        return Err(last_error("configure Job Object"));
    }

    let command_processor = std::env::var_os("COMSPEC")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    let shell_command = format!(
        "\"{}\" /D /S /C call \"{}\" 1>\"{}\" 2>\"{}\"",
        command_processor.display(),
        output_dir.join("command.cmd").display(),
        stdout_path.display(),
        stderr_path.display()
    );
    let mut command_line = wide_null(&shell_command);
    let application = wide_null(command_processor.as_os_str());
    let cwd = wide_null(std::ffi::OsStr::new(&request.cwd));
    let environment = environment_block(request);
    let security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: appcontainer.sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let mut attributes_size = 0usize;
    InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attributes_size);
    let mut attributes = vec![0usize; attributes_size.div_ceil(std::mem::size_of::<usize>())];
    let attributes_ptr = attributes.as_mut_ptr() as *mut c_void;
    if InitializeProcThreadAttributeList(attributes_ptr, 1, 0, &mut attributes_size) == 0 {
        return Err(last_error("initialize process attribute list"));
    }
    let attributes = OwnedAttributeList(attributes_ptr);
    if UpdateProcThreadAttribute(
        attributes.0,
        0,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
        &security_capabilities as *const _ as *const c_void,
        std::mem::size_of_val(&security_capabilities),
        null_mut(),
        null(),
    ) == 0
    {
        return Err(last_error("attach AppContainer security capabilities"));
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes.0;
    let mut process = PROCESS_INFORMATION::default();
    if CreateProcessAsUserW(
        restricted_token.0,
        application.as_ptr(),
        command_line.as_mut_ptr(),
        null(),
        null(),
        0,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.as_ptr() as *const c_void,
        cwd.as_ptr(),
        &startup.StartupInfo,
        &mut process,
    ) == 0
    {
        return Err(last_error("create restricted process"));
    }
    let child_process = OwnedHandle(process.hProcess);
    let child_thread = OwnedHandle(process.hThread);
    if AssignProcessToJobObject(job.0, child_process.0) == 0 {
        return Err(last_error("assign restricted process to Job Object"));
    }
    if ResumeThread(child_thread.0) == u32::MAX {
        return Err(last_error("resume restricted process"));
    }
    if WaitForSingleObject(
        child_process.0,
        request.timeout_ms.min(u32::MAX as u64) as u32,
    ) == WAIT_TIMEOUT
    {
        TerminateJobObject(job.0, 124);
        return Err(format!(
            "sandbox command timed out after {}ms",
            request.timeout_ms
        ));
    }
    let mut exit_code = 0;
    if GetExitCodeProcess(child_process.0, &mut exit_code) == 0 {
        return Err(last_error("read restricted process exit code"));
    }
    Ok(exit_code as i32)
}

const APP_CONTAINER_PREFIX: &str = "VolundCode.Sandbox.";
static PROFILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize, Serialize)]
struct AclJournal {
    profile_name: String,
    #[serde(default)]
    owner_pid: u32,
    paths: Vec<String>,
}

struct AppContainerLease {
    name: Vec<u16>,
    sid: PSID,
    paths: Vec<String>,
    journal_path: std::path::PathBuf,
}

impl AppContainerLease {
    unsafe fn create(request: &ExecRequest, output_dir: &Path) -> Result<Self, String> {
        let profile_name = unique_profile_name();
        let name = wide_null(&profile_name);
        let display = wide_null("volund Code Sandbox");
        let description = wide_null("Ephemeral volund Code Tier 2 sandbox");
        let mut sid: PSID = null_mut();
        let result = CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        );
        if result < 0 {
            return Err(format!(
                "create AppContainer profile: HRESULT 0x{result:08x}"
            ));
        }

        let mut grants = BTreeMap::<String, GrantSpec>::new();
        add_grant(
            &mut grants,
            &request.cwd,
            FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        )?;
        add_grant(
            &mut grants,
            &output_dir.to_string_lossy(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
        )?;
        for path in &request.permissions.fs.read {
            add_grant(&mut grants, path, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)?;
        }
        for path in &request.permissions.fs.write {
            add_grant(
                &mut grants,
                path,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
            )?;
        }

        let paths = grants.keys().cloned().collect::<Vec<_>>();
        let journal_path = journal_dir().join(format!("{profile_name}.json"));
        std::fs::create_dir_all(journal_dir())
            .map_err(|error| format!("create AppContainer ACL journal directory: {error}"))?;
        write_journal(
            &journal_path,
            &AclJournal {
                profile_name: profile_name.clone(),
                owner_pid: std::process::id(),
                paths: paths.clone(),
            },
        )?;

        let lease = Self {
            name,
            sid,
            paths,
            journal_path,
        };
        for (path, grant) in grants {
            if let Err(error) = grant_path(&path, lease.sid, grant) {
                drop(lease);
                return Err(error);
            }
        }
        Ok(lease)
    }
}

impl Drop for AppContainerLease {
    fn drop(&mut self) {
        unsafe {
            for path in &self.paths {
                let _ = revoke_path(path, self.sid);
            }
            let _ = DeleteAppContainerProfile(self.name.as_ptr());
            if !self.sid.is_null() {
                FreeSid(self.sid);
            }
        }
        let _ = std::fs::remove_file(&self.journal_path);
    }
}

fn unique_profile_name() -> String {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id() as u128;
    let sequence = PROFILE_SEQUENCE.fetch_add(1, Ordering::Relaxed) as u128;
    let value = ticks ^ (pid << 96) ^ sequence;
    format!(
        "{APP_CONTAINER_PREFIX}{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (value >> 96) as u32,
        (value >> 80) as u16,
        (value >> 64) as u16,
        (value >> 48) as u16,
        value & 0xffffffffffff
    )
}

fn journal_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("volund-sandbox-acl-journal")
}

fn write_journal(path: &Path, journal: &AclJournal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal)
        .map_err(|error| format!("serialize AppContainer ACL journal: {error}"))?;
    std::fs::write(path, bytes)
        .map_err(|error| format!("write AppContainer ACL journal {}: {error}", path.display()))
}

unsafe fn cleanup_orphaned_acls() -> Result<(), String> {
    let directory = journal_dir();
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read AppContainer ACL journals: {error}")),
    };
    for entry in entries {
        let path = entry
            .map_err(|error| format!("read AppContainer ACL journal entry: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|error| {
            format!("read AppContainer ACL journal {}: {error}", path.display())
        })?;
        let journal: AclJournal = serde_json::from_slice(&bytes).map_err(|error| {
            format!("parse AppContainer ACL journal {}: {error}", path.display())
        })?;
        if !journal.profile_name.starts_with(APP_CONTAINER_PREFIX) {
            return Err(format!("refusing foreign ACL journal {}", path.display()));
        }
        if journal.owner_pid != 0 && process_is_alive(journal.owner_pid) {
            continue;
        }
        let name = wide_null(&journal.profile_name);
        let mut sid: PSID = null_mut();
        let result = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid);
        if result >= 0 {
            for granted_path in &journal.paths {
                revoke_path(granted_path, sid)?;
            }
            FreeSid(sid);
        }
        let _ = DeleteAppContainerProfile(name.as_ptr());
        std::fs::remove_file(&path).map_err(|error| {
            format!(
                "remove AppContainer ACL journal {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

unsafe fn process_is_alive(pid: u32) -> bool {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
        return false;
    }
    let handle = OwnedHandle(handle);
    let mut exit_code = 0;
    GetExitCodeProcess(handle.0, &mut exit_code) != 0 && exit_code == 259
}

#[derive(Clone, Copy)]
struct GrantSpec {
    access: u32,
    inherit: bool,
}

fn add_grant(
    grants: &mut BTreeMap<String, GrantSpec>,
    path: &str,
    access: u32,
) -> Result<(), String> {
    if path.contains('*') {
        return Err(format!(
            "Windows AppContainer does not accept glob permission paths: {path}"
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("canonicalize AppContainer permission path {path}: {error}"))?;
    let inherit = canonical.is_dir();
    for ancestor in canonical.ancestors().skip(1) {
        if ancestor.parent().is_none() {
            continue;
        }
        let ancestor = ancestor.to_string_lossy().into_owned();
        grants
            .entry(ancestor)
            .and_modify(|existing| existing.access |= FILE_TRAVERSE)
            .or_insert(GrantSpec {
                access: FILE_TRAVERSE,
                inherit: false,
            });
    }
    let canonical = canonical.to_string_lossy().into_owned();
    grants
        .entry(canonical)
        .and_modify(|existing| {
            existing.access |= access;
            existing.inherit |= inherit;
        })
        .or_insert(GrantSpec { access, inherit });
    Ok(())
}

unsafe fn grant_path(path: &str, sid: PSID, grant: GrantSpec) -> Result<(), String> {
    update_path_acl(path, sid, GRANT_ACCESS, grant.access, grant.inherit)
}

unsafe fn revoke_path(path: &str, sid: PSID) -> Result<(), String> {
    update_path_acl(path, sid, REVOKE_ACCESS, 0, false)
}

unsafe fn update_path_acl(
    path: &str,
    sid: PSID,
    mode: i32,
    access: u32,
    inherit: bool,
) -> Result<(), String> {
    let path_wide = wide_null(path);
    let mut old_dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = GetNamedSecurityInfoW(
        path_wide.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null_mut(),
        null_mut(),
        &mut old_dacl,
        null_mut(),
        &mut descriptor,
    );
    if status != ERROR_SUCCESS {
        return Err(format!("read ACL for {path}: Windows error {status}"));
    }
    let descriptor = OwnedLocal(descriptor);
    let inheritance = if inherit {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        NO_INHERITANCE
    };
    let trustee = TRUSTEE_W {
        pMultipleTrustee: null_mut(),
        MultipleTrusteeOperation: 0,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid as *mut u16,
    };
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: access,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: trustee,
    };
    let mut new_dacl: *mut ACL = null_mut();
    let status = SetEntriesInAclW(1, &entry, old_dacl, &mut new_dacl);
    if status != ERROR_SUCCESS {
        return Err(format!("build ACL for {path}: Windows error {status}"));
    }
    let new_dacl = OwnedLocal(new_dacl as *mut c_void);
    let status = SetNamedSecurityInfoW(
        path_wide.as_ptr() as *mut u16,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        null_mut(),
        null_mut(),
        new_dacl.0 as *const ACL,
        null(),
    );
    drop(descriptor);
    if status != ERROR_SUCCESS {
        return Err(format!("write ACL for {path}: Windows error {status}"));
    }
    Ok(())
}

fn environment_block(request: &ExecRequest) -> Vec<u16> {
    let mut entries = request
        .env
        .iter()
        .filter(|(name, _)| request.permissions.env.read.contains(name))
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>();
    // CreateProcessAsUser/AppContainer initialization consumes these system
    // variables before user code starts. They carry paths, not credentials,
    // and are included independently of the caller's env allowlist.
    for required in [
        "ALLUSERSPROFILE",
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    ] {
        if let Ok(value) = std::env::var(required) {
            entries.push(format!("{required}={value}"));
        }
    }
    entries.sort_unstable_by_key(|value| value.to_ascii_uppercase());
    let mut block = entries
        .join("\0")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    block.push(0);
    block
}

fn wide_null(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_error(action: &str) -> String {
    format!("{action}: {}", std::io::Error::last_os_error())
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct OwnedAttributeList(*mut c_void);

impl Drop for OwnedAttributeList {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DeleteProcThreadAttributeList(self.0) };
        }
    }
}

struct OwnedLocal(*mut c_void);

impl Drop for OwnedLocal {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appcontainer_profiles_are_unique_and_namespaced() {
        let first = unique_profile_name();
        let second = unique_profile_name();
        assert!(first.starts_with(APP_CONTAINER_PREFIX));
        assert_ne!(first, second);
        assert_eq!(first.len(), APP_CONTAINER_PREFIX.len() + 36);
    }

    #[test]
    fn acl_journal_round_trips_owner_and_paths() {
        let journal = AclJournal {
            profile_name: unique_profile_name(),
            owner_pid: 42,
            paths: vec![r"C:\workspace".into()],
        };
        let encoded = serde_json::to_vec(&journal).unwrap();
        let decoded: AclJournal = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.profile_name, journal.profile_name);
        assert_eq!(decoded.owner_pid, 42);
        assert_eq!(decoded.paths, journal.paths);
    }

    #[test]
    fn appcontainer_acl_rejects_glob_paths() {
        let error =
            add_grant(&mut BTreeMap::new(), r"C:\workspace\*", FILE_GENERIC_READ).unwrap_err();
        assert!(error.contains("does not accept glob"));
    }
}
