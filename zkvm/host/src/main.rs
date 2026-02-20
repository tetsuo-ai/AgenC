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
        Some("image-id") => {
            print_image_id()
        }
        Some(other) => Err(format!(
            "unsupported command: {other}. usage: agenc-zkvm-host [prove|image-id]"
        )),
    }
}

fn print_image_id() -> Result<(), String> {
    #[cfg(feature = "production-prover")]
    {
        let image_id = agenc_zkvm_host::guest_id_to_image_id(
            &agenc_zkvm_methods::AGENC_GUEST_ID,
        );
        print!("[");
        for (i, byte) in image_id.iter().enumerate() {
            if i > 0 {
                print!(", ");
            }
            print!("0x{byte:02x}");
        }
        println!("]");
        Ok(())
    }
    #[cfg(not(feature = "production-prover"))]
    {
        Err("image-id requires --features production-prover (needs rzup toolchain)".into())
    }
}
