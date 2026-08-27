#[cfg(target_os = "linux")]
use crate::digest::verify_sha256;
#[cfg(target_os = "linux")]
use std::{
    fs::File,
    io::Write,
    os::fd::{AsRawFd, FromRawFd},
    path::{Path, PathBuf},
};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const PAYLOAD: &[u8] = include_bytes!("../resources/bwrap/x86_64-unknown-linux-gnu/bwrap");
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const SHA256: &str = "cbae2c7d261d540c9402a4476416d8f4cc16817b7d24b6b0439b749476f91199";

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const PAYLOAD: &[u8] = include_bytes!("../resources/bwrap/aarch64-unknown-linux-gnu/bwrap");
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub const SHA256: &str = "d50c8bccfcaf03b53390d8ea5ee6f7281cfe18766b009ba0c479f80f83485ec4";

#[cfg(target_os = "linux")]
pub struct MaterializedBwrap {
    _file: File,
    path: PathBuf,
}

#[cfg(target_os = "linux")]
impl MaterializedBwrap {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(target_os = "linux")]
pub fn materialize() -> Result<MaterializedBwrap, String> {
    // A memfd keeps the verified payload off the filesystem and removes the
    // verify/exec path-replacement race. CLOEXEC is deliberately cleared so
    // Command can execute the descriptor through /proc/self/fd.
    let fd = unsafe { libc::memfd_create(b"volund-bwrap\0".as_ptr().cast(), 0) };
    if fd < 0 {
        return Err(format!(
            "cannot create bundled bwrap memfd: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(PAYLOAD)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("cannot write bundled bwrap: {error}"))?;
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o500) } != 0 {
        return Err(format!(
            "cannot make bundled bwrap executable: {}",
            std::io::Error::last_os_error()
        ));
    }
    let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    verify_sha256(&path, SHA256)?;
    Ok(MaterializedBwrap { _file: file, path })
}

#[cfg(target_os = "linux")]
pub fn verify_embedded() -> Result<(), String> {
    drop(materialize()?);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn verify_embedded() -> Result<(), String> {
    Err("bundled bwrap is only available on Linux".into())
}
