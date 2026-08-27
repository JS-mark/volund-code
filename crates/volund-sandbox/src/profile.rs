use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxTier {
    None,
    Weak,
    Partial,
    Full,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct FsPermissions {
    #[serde(default)]
    pub read: Vec<String>,
    #[serde(default)]
    pub write: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Permissions {
    #[serde(default)]
    pub fs: FsPermissions,
    #[serde(default)]
    pub net: NetworkPermissions,
    #[serde(default)]
    pub env: EnvPermissions,
}

impl Permissions {
    /// Returns true only when every capability in `self` was already granted
    /// by `declared`. Backends must call this before applying a transformed
    /// profile so normalization can never widen PermissionSpec.
    pub fn is_subset_of(&self, declared: &Self) -> bool {
        self.net.is_subset_of(&declared.net)
            && self
                .fs
                .read
                .iter()
                .all(|path| declared.fs.read.contains(path))
            && self
                .fs
                .write
                .iter()
                .all(|path| declared.fs.write.contains(path))
            && self
                .env
                .read
                .iter()
                .all(|name| declared.env.read.contains(name))
    }
}

/// Network access is deny-by-default. `true` remains accepted on the wire for
/// older clients, but is deliberately not a valid Tier 3 profile because it
/// cannot be translated into a finite WFP policy.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum NetworkPermissions {
    #[default]
    Disabled,
    Legacy(bool),
    Allowlist {
        allowlist: Vec<String>,
    },
}

impl NetworkPermissions {
    pub fn allows_network(&self) -> bool {
        match self {
            Self::Legacy(value) => *value,
            Self::Allowlist { allowlist } => !allowlist.is_empty(),
            Self::Disabled => false,
        }
    }

    pub fn allowlist(&self) -> Result<&[String], String> {
        match self {
            Self::Disabled | Self::Legacy(false) => Ok(&[]),
            Self::Legacy(true) => {
                Err("Windows Tier 3 requires an explicit IP:port or hostname:port allowlist".into())
            }
            Self::Allowlist { allowlist } => Ok(allowlist),
        }
    }

    fn is_subset_of(&self, declared: &Self) -> bool {
        match (self, declared) {
            (Self::Disabled | Self::Legacy(false), _) => true,
            (Self::Legacy(true), Self::Legacy(true)) => true,
            (
                Self::Allowlist { allowlist },
                Self::Allowlist {
                    allowlist: declared,
                },
            ) => allowlist.iter().all(|entry| declared.contains(entry)),
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct EnvPermissions {
    #[serde(default)]
    pub read: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExecRequest {
    pub command: String,
    pub cwd: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}
fn default_timeout() -> u64 {
    60_000
}

impl ExecRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.command.trim().is_empty() {
            return Err("command must not be empty".into());
        }
        let cwd = std::fs::canonicalize(&self.cwd).map_err(|e| format!("invalid cwd: {e}"))?;
        for path in self
            .permissions
            .fs
            .write
            .iter()
            .chain(self.permissions.fs.read.iter())
        {
            if path.contains('*') {
                continue;
            }
            let candidate = std::path::Path::new(path);
            if !candidate.is_absolute() {
                return Err(format!("permission path must be absolute: {path}"));
            }
        }
        if self.permissions.fs.write.iter().any(|path| {
            let candidate = std::path::Path::new(path);
            candidate.is_absolute() && candidate.parent().is_none()
        }) {
            return Err("refusing writable filesystem root".into());
        }
        if cwd.as_os_str().is_empty() {
            return Err("cwd must not be empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u128,
    pub sandbox_tier: SandboxTier,
    pub sandbox_violations: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProbeInfo {
    pub platform: String,
    pub arch: String,
    pub libc: Option<String>,
    pub os_version: String,
    pub tier: SandboxTier,
    pub features: BTreeMap<String, serde_json::Value>,
    pub known_limitations: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_profile_that_writes_entire_root() {
        let mut request = ExecRequest {
            command: "true".into(),
            cwd: "/".into(),
            timeout_ms: 1,
            permissions: Permissions::default(),
            env: BTreeMap::new(),
        };
        request.permissions.fs.write.push("/".into());
        assert!(request
            .validate()
            .unwrap_err()
            .contains("writable filesystem root"));
    }

    #[test]
    fn transformed_profile_cannot_widen_declared_permissions() {
        let declared = Permissions {
            fs: FsPermissions {
                read: vec!["/workspace/**".into()],
                write: vec![],
            },
            net: NetworkPermissions::Disabled,
            env: EnvPermissions {
                read: vec!["PATH".into()],
            },
        };
        let widened = Permissions {
            fs: FsPermissions {
                read: declared.fs.read.clone(),
                write: vec!["/workspace/**".into()],
            },
            net: NetworkPermissions::Legacy(true),
            env: EnvPermissions {
                read: vec!["PATH".into(), "HOME".into()],
            },
        };
        assert!(!widened.is_subset_of(&declared));
        assert!(declared.is_subset_of(&declared));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn refuses_profile_that_writes_windows_drive_root() {
        let mut request = ExecRequest {
            command: "echo safe".into(),
            cwd: r"C:\".into(),
            timeout_ms: 1,
            permissions: Permissions::default(),
            env: BTreeMap::new(),
        };
        request.permissions.fs.write.push(r"C:\".into());
        assert!(request
            .validate()
            .unwrap_err()
            .contains("writable filesystem root"));
    }
}
