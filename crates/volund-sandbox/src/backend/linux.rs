use super::{execute, seccomp_arch_for, SeccompArch};
use crate::bundled_bwrap;
use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{collections::BTreeMap, process::Command};

fn seccomp_arch() -> Result<SeccompArch, String> {
    seccomp_arch_for(std::env::consts::ARCH)
}
pub fn probe() -> ProbeInfo {
    let bwrap = bundled_bwrap::verify_embedded().is_ok();
    let seccomp = seccomp_arch().is_ok();
    ProbeInfo {
        platform: "linux".into(),
        arch: std::env::consts::ARCH.into(),
        libc: Some(
            if cfg!(target_env = "musl") {
                "musl"
            } else {
                "gnu"
            }
            .into(),
        ),
        os_version: Command::new("uname")
            .arg("-r")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().into())
            .unwrap_or_default(),
        tier: if bwrap && seccomp {
            SandboxTier::Full
        } else {
            SandboxTier::None
        },
        features: BTreeMap::from([
            ("namespaces".into(), bwrap.into()),
            ("seccomp".into(), seccomp.into()),
        ]),
        known_limitations: if bwrap {
            vec!["seccomp filter installation is pending vendor integration".into()]
        } else {
            vec!["bundled bwrap failed digest verification".into()]
        },
    }
}
pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    let (command, _bundled) = command(request, false)?;
    execute(command, SandboxTier::Full)
}
fn command(
    request: &ExecRequest,
    preserve_bridge_fd: bool,
) -> Result<(Command, bundled_bwrap::MaterializedBwrap), String> {
    let bundled = bundled_bwrap::materialize()
        .map_err(|error| format!("bundled bwrap unavailable; refusing execution: {error}"))?;
    seccomp_arch()?;
    let mut command = Command::new(bundled.path());
    command.args([
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]);
    if !request.permissions.net.allows_network() {
        command.arg("--unshare-net");
    }
    for writable in &request.permissions.fs.write {
        let path = writable.trim_end_matches("/**");
        command.args(["--bind", path, path]);
    }
    command.args(["--chdir", &request.cwd, "--clearenv"]);
    for key in &request.permissions.env.read {
        if let Ok(value) = std::env::var(key) {
            command.args(["--setenv", key, &value]);
        }
    }
    if preserve_bridge_fd {
        // bwrap closes inherited descriptors above stderr unless explicitly
        // told how many to retain. The plugin RPC transport is exactly fd 3.
        command.args(["--preserve-fds", "1"]);
    }
    command.args(["/bin/sh", "-c", &request.command]);
    Ok((command, bundled))
}
pub(crate) fn exec_persistent(request: &ExecRequest) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    preserve_inherited_fd(3)?;
    let (mut command, _bundled) = command(request, true)?;
    Err(format!(
        "failed to execute sandbox backend: {}",
        command.exec()
    ))
}

fn preserve_inherited_fd(fd: libc::c_int) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(format!(
            "plugin bridge fd unavailable: {}",
            std::io::Error::last_os_error()
        ));
    }
    if flags & libc::FD_CLOEXEC != 0
        && unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0
    {
        return Err(format!(
            "cannot preserve plugin bridge fd: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;
    #[test]
    fn runtime_selects_digest_verified_bundled_bwrap() {
        let bundled = bundled_bwrap::materialize().expect("materialize reviewed payload");
        assert!(bundled.path().starts_with("/proc/self/fd"));
        assert_ne!(bundled.path(), std::path::Path::new("/usr/bin/bwrap"));
        crate::digest::verify_sha256(bundled.path(), bundled_bwrap::SHA256)
            .expect("runtime payload must match the architecture digest");
    }

    #[test]
    fn bundled_bwrap_accepts_plugin_bridge_preservation_contract() {
        let request = ExecRequest {
            command: "/bin/true".into(),
            cwd: "/".into(),
            timeout_ms: 1_000,
            permissions: Default::default(),
            env: BTreeMap::new(),
        };
        let (command, _bundled) = command(&request, true).expect("build bwrap command");
        assert!(command
            .get_args()
            .any(|argument| argument == "--preserve-fds"));
    }

    #[test]
    fn inherited_bridge_fd_survives_the_bwrap_exec() {
        let file = std::fs::File::open("/dev/null").expect("open test fd");
        let fd = file.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) },
            0
        );

        preserve_inherited_fd(fd).expect("preserve inherited fd");

        let preserved = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(preserved >= 0);
        assert_eq!(preserved & libc::FD_CLOEXEC, 0);
    }
}
