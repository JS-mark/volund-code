use volund_sandbox::{
    bundled_bwrap, digest::verify_sha256, plugin::run_plugin, probe, run, ExecRequest,
};
use std::io::Read;
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let probe_mode = args.iter().any(|arg| arg == "--probe");
    if probe_mode {
        println!(
            "{}",
            serde_json::to_string(&probe()).expect("serialize probe")
        );
        return;
    }
    if args.first().map(String::as_str) == Some("--verify-bwrap-digest") {
        let verification = if args.len() == 1 {
            bundled_bwrap::verify_embedded()
        } else if args.len() == 3 {
            verify_sha256(std::path::Path::new(&args[1]), &args[2])
        } else {
            Err("usage: volund-sandbox --verify-bwrap-digest [path sha256]".into())
        };
        match verification {
            Ok(()) => {
                println!("{{\"verified\":true}}");
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    if args.first().map(String::as_str) == Some("--run-plugin") {
        let value = |flag: &str| {
            args.windows(2)
                .find(|pair| pair[0] == flag)
                .map(|pair| pair[1].as_str())
        };
        let result = match (value("--entry"), value("--data-dir"), value("--sandbox-profile"), value("--bridge-fd")) {
            (Some(entry), Some(data), Some(profile), Some(fd)) if args.len() == 9 => run_plugin(entry, data, profile, fd),
            _ => Err("usage: volund-sandbox --run-plugin --entry <file> --data-dir <dir> --sandbox-profile <json> --bridge-fd 3".into()),
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read stdin");
    let result = serde_json::from_str::<ExecRequest>(&input)
        .map_err(|e| format!("invalid request: {e}"))
        .and_then(|r| run(&r));
    match result {
        Ok(value) => println!(
            "{}",
            serde_json::to_string(&value).expect("serialize result")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}
