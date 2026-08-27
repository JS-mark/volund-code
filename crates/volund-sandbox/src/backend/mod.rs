use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{collections::BTreeMap, process::Command, time::Instant};

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SeccompArch {
    X86_64,
    Aarch64,
}

#[cfg(any(target_os = "linux", test))]
fn seccomp_arch_for(arch: &str) -> Result<SeccompArch, String> {
    match arch {
        "x86_64" => Ok(SeccompArch::X86_64),
        "aarch64" => Ok(SeccompArch::Aarch64),
        arch => Err(format!("unsupported seccomp architecture: {arch}")),
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub fn probe() -> ProbeInfo {
    #[cfg(target_os = "macos")]
    {
        return macos::probe();
    }
    #[cfg(target_os = "linux")]
    {
        return linux::probe();
    }
    #[cfg(target_os = "windows")]
    {
        return windows::probe();
    }
    #[allow(unreachable_code)]
    ProbeInfo {
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        libc: None,
        os_version: String::new(),
        tier: SandboxTier::None,
        features: BTreeMap::new(),
        known_limitations: vec!["unsupported L1 platform".into()],
    }
}

pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    request.validate()?;
    #[cfg(target_os = "macos")]
    {
        return macos::run(request);
    }
    #[cfg(target_os = "linux")]
    {
        return linux::run(request);
    }
    #[cfg(target_os = "windows")]
    {
        return windows::run(request);
    }
    #[allow(unreachable_code)]
    Err("sandbox unavailable on this L1 platform".into())
}

/// Replace this process with the sandbox backend. This preserves the dedicated
/// bridge fd and makes killing the launcher kill the actual plugin host.
pub fn exec_persistent(request: &ExecRequest) -> Result<(), String> {
    request.validate()?;
    #[cfg(target_os = "linux")]
    return linux::exec_persistent(request);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let mut command = macos::command(request)?;
        Err(format!(
            "failed to execute sandbox backend: {}",
            command.exec()
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err("persistent plugin host is not yet supported by this sandbox backend".into())
}

fn execute(mut command: Command, tier: SandboxTier) -> Result<ExecResult, String> {
    let started = Instant::now();
    let output = command
        .output()
        .map_err(|e| format!("failed to execute sandbox backend: {e}"))?;
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(128),
        duration_ms: started.elapsed().as_millis(),
        sandbox_tier: tier,
        sandbox_violations: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seccomp_arch_matrix_selects_only_reviewed_native_targets() {
        assert_eq!(seccomp_arch_for("x86_64"), Ok(SeccompArch::X86_64));
        assert_eq!(seccomp_arch_for("aarch64"), Ok(SeccompArch::Aarch64));
        for arch in ["amd64", "arm64", "x86", "riscv64", ""] {
            assert_eq!(
                seccomp_arch_for(arch),
                Err(format!("unsupported seccomp architecture: {arch}"))
            );
        }
    }
}
