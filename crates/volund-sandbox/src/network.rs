use std::{
    collections::BTreeSet,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PinnedEndpoint {
    pub address: IpAddr,
    pub port: u16,
}

/// Resolves the complete allowlist once, before a sandbox process starts.
/// Backends install only the returned IP:port tuples; they never authorize a
/// hostname at connect time, which closes the DNS rebinding window.
pub fn resolve_allowlist(entries: &[String]) -> Result<Vec<PinnedEndpoint>, String> {
    let mut pinned = BTreeSet::new();
    for entry in entries {
        let (host, port) = split_endpoint(entry)?;
        let resolved = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|error| format!("resolve network allowlist entry {entry}: {error}"))?
            .collect::<Vec<SocketAddr>>();
        if resolved.is_empty() {
            return Err(format!(
                "network allowlist entry resolved to no addresses: {entry}"
            ));
        }
        for endpoint in resolved {
            let address = endpoint.ip();
            if address.is_unspecified() || address.is_multicast() {
                return Err(format!(
                    "unsafe network allowlist address {address} in {entry}"
                ));
            }
            pinned.insert(PinnedEndpoint { address, port });
        }
    }
    Ok(pinned.into_iter().collect())
}

fn split_endpoint(entry: &str) -> Result<(String, u16), String> {
    let entry = entry.trim();
    if entry.is_empty() || entry.contains('*') || entry.contains('/') {
        return Err(format!(
            "network allowlist requires an exact host:port: {entry}"
        ));
    }
    let (host, port) = if let Some(rest) = entry.strip_prefix('[') {
        let (host, port) = rest
            .split_once("]:")
            .ok_or_else(|| format!("IPv6 allowlist entry must use [address]:port: {entry}"))?;
        (host, port)
    } else {
        if entry.matches(':').count() != 1 {
            return Err(format!(
                "IPv6 allowlist entry must use [address]:port: {entry}"
            ));
        }
        entry
            .rsplit_once(':')
            .ok_or_else(|| format!("network allowlist entry must include a port: {entry}"))?
    };
    if host.is_empty() || host.ends_with('.') || host.chars().any(char::is_whitespace) {
        return Err(format!("invalid network allowlist host: {entry}"));
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("invalid network allowlist port: {entry}"))?;
    if port == 0 {
        return Err(format!("network allowlist port must be non-zero: {entry}"));
    }
    Ok((host.to_ascii_lowercase(), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_ipv6_and_deduplicates_exact_endpoints() {
        let endpoints = resolve_allowlist(&[
            "127.0.0.1:443".into(),
            "[::1]:443".into(),
            "127.0.0.1:443".into(),
        ])
        .unwrap();
        assert_eq!(endpoints.len(), 2);
        assert!(endpoints.iter().any(|value| value.address.is_ipv4()));
        assert!(endpoints.iter().any(|value| value.address.is_ipv6()));
    }

    #[test]
    fn rejects_ambiguous_or_broad_rules() {
        for entry in [
            "example.com",
            "*.example.com:443",
            "0.0.0.0:443",
            "::1:443",
            "127.0.0.1:0",
        ] {
            assert!(
                resolve_allowlist(&[entry.into()]).is_err(),
                "accepted {entry}"
            );
        }
    }
}
