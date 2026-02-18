fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args();
    let _bin = args.next();

    match args.next().as_deref() {
        None | Some("prove") => {
            let request = agenc_zkvm_host::default_prove_request();
            let output =
                agenc_zkvm_host::prove_cli_output(&request).map_err(|err| err.to_string())?;
            println!("{output}");
            Ok(())
        }
        Some(other) => Err(format!(
            "unsupported command: {other}. usage: agenc-zkvm-host [prove]"
        )),
    }
}
