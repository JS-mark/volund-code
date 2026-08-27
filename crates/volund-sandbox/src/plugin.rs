use crate::{
    backend::exec_persistent,
    probe,
    profile::{
        EnvPermissions, ExecRequest, FsPermissions, NetworkPermissions, Permissions, SandboxTier,
    },
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
};

const MAX_PROFILE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
struct Limits {
    cpu_seconds: u64,
    rss_mb: u64,
    processes: u64,
    open_files: u64,
}

#[derive(Debug, Deserialize)]
struct PluginProfile {
    fs: FsPermissions,
    net: NetworkPermissions,
    env: EnvPermissions,
    limits: Limits,
}

#[derive(Debug, Deserialize)]
struct PluginManifest {
    main: String,
}

// Kept inside the verified native binary so callers cannot substitute a host loader.
const HOST: &str = include_str!("plugin_host.mjs");

pub fn run_plugin(
    entry: &str,
    data_dir: &str,
    profile_json: &str,
    bridge_fd: &str,
) -> Result<(), String> {
    if bridge_fd != "3" {
        return Err("bridge-fd must be exactly 3".into());
    }
    if profile_json.len() > MAX_PROFILE_BYTES {
        return Err("sandbox profile exceeds 65536 bytes".into());
    }
    if probe().tier == SandboxTier::None {
        return Err("sandbox unavailable; refusing unsandboxed plugin host".into());
    }
    let profile: PluginProfile =
        serde_json::from_str(profile_json).map_err(|_| "invalid sandbox profile".to_string())?;
    validate_limits(&profile.limits)?;
    let entry = canonical_file(entry)?;
    validate_manifest_entry(&entry)?;
    let data_dir = canonical_dir(data_dir)?;
    let roots = canonical_roots(&profile.fs.read)?;
    if !roots.iter().any(|root| entry.starts_with(root)) {
        return Err("plugin entry is outside approved read roots".into());
    }
    if !canonical_roots(&profile.fs.write)?
        .iter()
        .any(|root| data_dir.starts_with(root))
    {
        return Err("plugin data directory is outside approved write roots".into());
    }
    // Linux bwrap deliberately clears the environment, including PATH. Resolve
    // the trusted host runtime before entering the sandbox so plugin activation
    // does not depend on a shell-specific fallback PATH.
    let node = executable_on_path("node")?;
    let command = plugin_host_command(&node, &entry, &profile.limits);
    let request = ExecRequest {
        command,
        cwd: entry.parent().unwrap().to_string_lossy().into_owned(),
        timeout_ms: profile.limits.cpu_seconds.saturating_mul(1000).max(1),
        permissions: Permissions {
            fs: profile.fs,
            net: profile.net,
            env: profile.env,
        },
        env: BTreeMap::new(),
    };
    exec_persistent(&request)
}

fn plugin_host_command(node: &Path, entry: &Path, limits: &Limits) -> String {
    format!(
        "ulimit -t {}; ulimit -n {}; exec {} --max-old-space-size={} --input-type=module -e {} -- {}",
        limits.cpu_seconds,
        limits.open_files,
        shell_quote(&node.to_string_lossy()),
        limits.rss_mb,
        shell_quote(HOST),
        shell_quote(&entry.to_string_lossy())
    )
}

fn validate_manifest_entry(entry: &Path) -> Result<(), String> {
    let root = entry
        .parent()
        .ok_or_else(|| "plugin entry has no bundle root".to_string())?;
    let manifest_path = root.join("manifest.json");
    let metadata = std::fs::symlink_metadata(&manifest_path)
        .map_err(|_| "plugin manifest does not exist".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("plugin manifest must be a regular non-symlink file".into());
    }
    let manifest: PluginManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path).map_err(|_| "cannot read plugin manifest".to_string())?,
    )
    .map_err(|_| "invalid plugin manifest".to_string())?;
    let declared = Path::new(&manifest.main);
    if declared.is_absolute()
        || declared
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("plugin manifest main path escapes bundle".into());
    }
    if canonical_file(&root.join(declared).to_string_lossy())? != entry {
        return Err("plugin entry does not match manifest main".into());
    }
    Ok(())
}

fn canonical_file(value: &str) -> Result<PathBuf, String> {
    let original = Path::new(value);
    let metadata = std::fs::symlink_metadata(original)
        .map_err(|_| "plugin entry does not exist".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("plugin entry symlink rejected".into());
    }
    if !metadata.is_file() {
        return Err("plugin entry must be a regular file".into());
    }
    std::fs::canonicalize(original).map_err(|_| "invalid plugin entry".into())
}
fn canonical_dir(value: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(value)
        .map_err(|_| "plugin data directory does not exist".to_string())?;
    if !path.is_dir() {
        return Err("plugin data directory must be a directory".into());
    }
    Ok(path)
}
fn canonical_roots(values: &[String]) -> Result<Vec<PathBuf>, String> {
    values
        .iter()
        .map(|value| {
            std::fs::canonicalize(value.trim_end_matches("/**"))
                .map_err(|_| "sandbox profile contains a missing root".into())
        })
        .collect()
}
fn executable_on_path(name: &str) -> Result<PathBuf, String> {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| std::fs::canonicalize(candidate).ok())
        .ok_or_else(|| format!("plugin host runtime not found: {name}"))
}
fn validate_limits(limits: &Limits) -> Result<(), String> {
    if limits.cpu_seconds == 0
        || limits.cpu_seconds > 300
        || limits.rss_mb == 0
        || limits.rss_mb > 4096
        || limits.processes != 1
        || limits.open_files < 4
        || limits.open_files > 1024
    {
        return Err("sandbox resource limits are invalid".into());
    }
    Ok(())
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_arguments_are_single_quoted() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }
    #[test]
    fn plugin_host_caps_v8_heap_without_limiting_virtual_address_space() {
        let limits = Limits {
            cpu_seconds: 30,
            rss_mb: 256,
            processes: 1,
            open_files: 64,
        };
        let command = plugin_host_command(
            Path::new("/runtime/node"),
            Path::new("/plugin/main.mjs"),
            &limits,
        );
        assert!(command.contains("--max-old-space-size=256"));
        assert!(!command.contains("ulimit -v"));
    }
    #[test]
    fn rejects_unknown_bridge_fd_before_probe() {
        assert!(run_plugin("x", "x", "{}", "4")
            .unwrap_err()
            .contains("exactly 3"));
    }
    #[test]
    fn rejects_oversized_profile_before_probe() {
        assert!(
            run_plugin("x", "x", &"x".repeat(MAX_PROFILE_BYTES + 1), "3")
                .unwrap_err()
                .contains("exceeds")
        );
    }
}
