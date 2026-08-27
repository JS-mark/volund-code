use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expected digest must be exactly 64 hexadecimal characters".into());
    }
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "SHA256 mismatch for {}: expected {expected}, got {actual}",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn rejects_tampered_bwrap_payload() {
        let path = std::env::temp_dir().join(format!(
            "volund-bwrap-digest-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, b"known bundled bwrap").unwrap();
        let expected = sha256_file(&path).unwrap();
        verify_sha256(&path, &expected).unwrap();
        fs::write(&path, b"tampered bundled bwrap").unwrap();
        assert!(verify_sha256(&path, &expected)
            .unwrap_err()
            .contains("SHA256 mismatch"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn pinned_upstream_snapshots_match_reviewed_digests() {
        let vendor =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../volund-sandbox-vendor/upstream");
        for (relative, expected) in [
            (
                "sandboxing/src/seatbelt_base_policy.sbpl",
                "9a7a181ac5fab3e8fcecfeeec280f8b0d4fd60c852cf71cdf3b5c65d02401e0c",
            ),
            (
                "sandboxing/src/restricted_read_only_platform_defaults.sbpl",
                "3365fee8421135a25bf1c7bcc36f637961024dbbaa1e97d94acb41265090e02f",
            ),
            (
                "linux-sandbox/src/bundled_bwrap.rs",
                "a87780f4a20d8cc4efa507054bb9ac539084ed5bc404d53d87bc3f29c26eced5",
            ),
            (
                "windows-sandbox-rs/src/lib.rs",
                "4fa052f4b2c6953fb5a0f764e90d25b6c5efd25703b0be12148e752b0d27c655",
            ),
        ] {
            verify_sha256(&vendor.join(relative), expected).unwrap();
        }
    }
}
