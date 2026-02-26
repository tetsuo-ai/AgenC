use std::io::Read;

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
            let use_stdin = args.any(|a| a == "--stdin");
            let request = if use_stdin {
                parse_request_from_stdin()?
            } else {
                agenc_zkvm_host::default_prove_request()
            };
            let output =
                agenc_zkvm_host::prove_cli_output(&request).map_err(|err| err.to_string())?;
            println!("{output}");
            Ok(())
        }
        Some("image-id") => print_image_id(),
        Some(other) => Err(format!(
            "unsupported command: {other}. usage: agenc-zkvm-host [prove [--stdin]|image-id]"
        )),
    }
}

#[derive(serde::Deserialize)]
struct JsonProveRequest {
    task_pda: Vec<u8>,
    agent_authority: Vec<u8>,
    constraint_hash: Vec<u8>,
    output_commitment: Vec<u8>,
    binding: Vec<u8>,
    nullifier: Vec<u8>,
    model_commitment: Vec<u8>,
    input_commitment: Vec<u8>,
}

fn vec_to_field(name: &str, v: Vec<u8>) -> Result<[u8; 32], String> {
    v.try_into()
        .map_err(|v: Vec<u8>| format!("{name} must be 32 bytes, got {}", v.len()))
}

fn parse_request_from_stdin() -> Result<agenc_zkvm_host::ProveRequest, String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| format!("failed to read stdin: {e}"))?;

    let json: JsonProveRequest =
        serde_json::from_str(&input).map_err(|e| format!("invalid JSON input: {e}"))?;

    Ok(agenc_zkvm_host::ProveRequest {
        task_pda: vec_to_field("task_pda", json.task_pda)?,
        agent_authority: vec_to_field("agent_authority", json.agent_authority)?,
        constraint_hash: vec_to_field("constraint_hash", json.constraint_hash)?,
        output_commitment: vec_to_field("output_commitment", json.output_commitment)?,
        binding: vec_to_field("binding", json.binding)?,
        nullifier: vec_to_field("nullifier", json.nullifier)?,
        model_commitment: vec_to_field("model_commitment", json.model_commitment)?,
        input_commitment: vec_to_field("input_commitment", json.input_commitment)?,
    })
}

fn print_image_id() -> Result<(), String> {
    #[cfg(feature = "production-prover")]
    {
        let image_id = agenc_zkvm_host::guest_id_to_image_id(&agenc_zkvm_methods::AGENC_GUEST_ID);

        println!("=== RISC Zero Image ID (from guest ELF) ===\n");

        // Rust constant format (for complete_task_private.rs)
        println!("// Rust (programs/.../complete_task_private.rs)");
        print!("const TRUSTED_RISC0_IMAGE_ID: [u8; RISC0_IMAGE_ID_LEN] = [\n    ");
        for (i, byte) in image_id.iter().enumerate() {
            if i > 0 && i % 11 == 0 {
                print!("\n    ");
            } else if i > 0 {
                print!(", ");
            }
            print!("{byte}");
        }
        println!(",\n];\n");

        // TypeScript constant format (for sdk/src/constants.ts)
        println!("// TypeScript (sdk/src/constants.ts)");
        print!("export const TRUSTED_RISC0_IMAGE_ID = Uint8Array.from([\n  ");
        for (i, byte) in image_id.iter().enumerate() {
            if i > 0 && i % 11 == 0 {
                print!("\n  ");
            } else if i > 0 {
                print!(", ");
            }
            print!("{byte}");
        }
        println!(",\n]);\n");

        // Raw hex for verification
        print!("// Hex: ");
        for byte in &image_id {
            print!("{byte:02x}");
        }
        println!();

        Ok(())
    }
    #[cfg(not(feature = "production-prover"))]
    {
        Err(concat!(
            "image-id requires --features production-prover (needs rzup toolchain).\n",
            "Install: curl -L https://risczero.com/install | bash && rzup install\n",
            "Then: cargo run -p agenc-zkvm-host --features production-prover -- image-id"
        )
        .into())
    }
}
