#![forbid(unsafe_code)]

use std::{ffi::OsStr, fmt};

pub mod config;

use agenc_zkvm_guest::{JournalField, JournalFields};
#[cfg(feature = "production-prover")]
use agenc_zkvm_guest::{serialize_journal, JOURNAL_TOTAL_LEN};
#[cfg(feature = "production-prover")]
use borsh::BorshSerialize;
use verifier_router::Selector;
#[cfg(feature = "production-prover")]
use verifier_router::{client::encode_seal_with_selector, Seal};

pub const IMAGE_ID_LEN: usize = 32;
pub const SEAL_SELECTOR_LEN: usize = 4;
pub const SEAL_PROOF_LEN: usize = 256;
pub const SEAL_BYTES_LEN: usize = SEAL_SELECTOR_LEN + SEAL_PROOF_LEN;
pub const TRUSTED_SEAL_SELECTOR: Selector = [0x52, 0x5a, 0x56, 0x4d];
pub const DEV_MODE_ENV_VAR: &str = "RISC0_DEV_MODE";

pub type ImageId = [u8; IMAGE_ID_LEN];
#[cfg(feature = "production-prover")]
type ProofBytes = [u8; SEAL_PROOF_LEN];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProveRequest {
    pub task_pda: JournalField,
    pub agent_authority: JournalField,
    pub constraint_hash: JournalField,
    pub output_commitment: JournalField,
    pub binding: JournalField,
    pub nullifier: JournalField,
}

impl From<ProveRequest> for JournalFields {
    fn from(r: ProveRequest) -> Self {
        Self {
            task_pda: r.task_pda,
            agent_authority: r.agent_authority,
            constraint_hash: r.constraint_hash,
            output_commitment: r.output_commitment,
            binding: r.binding,
            nullifier: r.nullifier,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProveResponse {
    pub seal_bytes: Vec<u8>,
    pub journal: Vec<u8>,
    pub image_id: ImageId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProveError {
    UnexpectedJournalLength {
        expected: usize,
        actual: usize,
    },
    UntrustedSelector {
        expected: Selector,
        actual: Selector,
    },
    DevModeEnabled {
        variable: &'static str,
    },
    ClusterNotAllowlisted {
        cluster: String,
    },
    SealEncodingFailed(String),
    ProverFailed(String),
    ReceiptTypeMismatch(String),
}

impl fmt::Display for ProveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedJournalLength { expected, actual } => {
                write!(
                    f,
                    "unexpected journal length: expected {}, got {}",
                    expected, actual
                )
            }
            Self::UntrustedSelector { expected, actual } => {
                write!(
                    f,
                    "untrusted selector: expected {:?}, got {:?}",
                    expected, actual
                )
            }
            Self::DevModeEnabled { variable } => {
                write!(f, "{variable} is set; refusing to generate proof output")
            }
            Self::ClusterNotAllowlisted { cluster } => {
                write!(
                    f,
                    "cluster is not allowlisted for trusted router deployment: {cluster}"
                )
            }
            Self::SealEncodingFailed(message) => {
                write!(f, "seal encoding failed: {message}")
            }
            Self::ProverFailed(message) => {
                write!(f, "prover failed: {message}")
            }
            Self::ReceiptTypeMismatch(message) => {
                write!(f, "receipt type mismatch: {message}")
            }
        }
    }
}

impl std::error::Error for ProveError {}

pub fn default_prove_request() -> ProveRequest {
    ProveRequest {
        task_pda: [1_u8; 32],
        agent_authority: [2_u8; 32],
        constraint_hash: [3_u8; 32],
        output_commitment: [4_u8; 32],
        binding: [5_u8; 32],
        nullifier: [6_u8; 32],
    }
}

/// Convert RISC Zero `[u32; 8]` image ID to flat `[u8; 32]`.
/// RISC Zero stores Digest words in little-endian order.
pub fn guest_id_to_image_id(guest_id: &[u32; 8]) -> ImageId {
    let mut out = [0u8; IMAGE_ID_LEN];
    for (i, word) in guest_id.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    out
}

pub fn generate_proof(request: &ProveRequest) -> Result<ProveResponse, ProveError> {
    let dev_mode_value = std::env::var_os(DEV_MODE_ENV_VAR);
    generate_proof_with_dev_mode(request, dev_mode_value.as_deref())
}

fn generate_proof_with_dev_mode(
    request: &ProveRequest,
    dev_mode_value: Option<&OsStr>,
) -> Result<ProveResponse, ProveError> {
    ensure_allowlisted_deployment(config::DEFAULT_CLUSTER)?;
    ensure_dev_mode_disabled(dev_mode_value)?;

    #[cfg(feature = "production-prover")]
    {
        generate_proof_real(request)
    }
    #[cfg(not(feature = "production-prover"))]
    {
        let _ = request;
        Err(ProveError::ProverFailed(
            "Proof generation requires building with --features production-prover. \
             Install the RISC Zero toolchain: curl -L https://risczero.com/install | bash && rzup".into()
        ))
    }
}

// ---------------------------------------------------------------------------
// Real prover path (production-prover feature)
// ---------------------------------------------------------------------------

#[cfg(feature = "production-prover")]
fn generate_proof_real(request: &ProveRequest) -> Result<ProveResponse, ProveError> {
    use agenc_zkvm_guest::JOURNAL_FIELD_LEN;
    use agenc_zkvm_methods::AGENC_GUEST_ELF;
    use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};

    let fields: &[(&str, &[u8; JOURNAL_FIELD_LEN])] = &[
        ("task_pda", &request.task_pda),
        ("agent_authority", &request.agent_authority),
        ("constraint_hash", &request.constraint_hash),
        ("output_commitment", &request.output_commitment),
        ("binding", &request.binding),
        ("nullifier", &request.nullifier),
    ];

    let mut builder = ExecutorEnv::builder();
    for (name, field) in fields {
        builder
            .write(*field)
            .map_err(|e| ProveError::ProverFailed(format!("failed to write {name}: {e}")))?;
    }
    let env = builder
        .build()
        .map_err(|e| ProveError::ProverFailed(format!("failed to build executor env: {e}")))?;

    let receipt = default_prover()
        .prove_with_opts(env, AGENC_GUEST_ELF, &ProverOpts::groth16())
        .map_err(|e| ProveError::ProverFailed(format!("Groth16 proving failed: {e}")))?
        .receipt;

    // Extract raw 256-byte Groth16 seal
    let groth16 = receipt
        .inner
        .groth16()
        .map_err(|e| ProveError::ReceiptTypeMismatch(format!("expected Groth16 receipt: {e}")))?;
    let raw_seal: [u8; SEAL_PROOF_LEN] =
        groth16.seal.clone().try_into().map_err(|v: Vec<u8>| {
            ProveError::ProverFailed(format!(
                "Groth16 seal is {} bytes, expected {}",
                v.len(),
                SEAL_PROOF_LEN
            ))
        })?;

    // NOTE: TRUSTED_SEAL_SELECTOR is a fixed identifier registered with the
    // Verifier Router, not derived from Groth16ReceiptVerifierParameters.
    // The router's encode_seal_with_selector() applies it during encoding.

    let seal_bytes = encode_seal(&raw_seal)?;

    // Extract and validate journal
    let journal = receipt.journal.bytes.clone();
    if journal.len() != JOURNAL_TOTAL_LEN {
        return Err(ProveError::UnexpectedJournalLength {
            expected: JOURNAL_TOTAL_LEN,
            actual: journal.len(),
        });
    }

    // Derive image ID from the compiled guest
    let image_id = guest_id_to_image_id(&agenc_zkvm_methods::AGENC_GUEST_ID);

    Ok(ProveResponse {
        seal_bytes,
        journal,
        image_id,
    })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub fn prove_cli_output(request: &ProveRequest) -> Result<String, ProveError> {
    let response = generate_proof(request)?;
    Ok(render_prove_response(&response))
}

pub fn render_prove_response(response: &ProveResponse) -> String {
    #[derive(serde::Serialize)]
    struct JsonProveResponse {
        seal_bytes: Vec<u8>,
        journal: Vec<u8>,
        image_id: Vec<u8>,
    }

    let json_resp = JsonProveResponse {
        seal_bytes: response.seal_bytes.clone(),
        journal: response.journal.clone(),
        image_id: response.image_id.to_vec(),
    };
    serde_json::to_string(&json_resp).expect("ProveResponse serialization cannot fail")
}

#[cfg(feature = "production-prover")]
fn encode_seal(proof_bytes: &ProofBytes) -> Result<Vec<u8>, ProveError> {
    let seal: Seal = encode_seal_with_selector(proof_bytes, TRUSTED_SEAL_SELECTOR);
    debug_assert_eq!(
        seal.selector, TRUSTED_SEAL_SELECTOR,
        "encode_seal_with_selector produced unexpected selector"
    );

    seal.try_to_vec()
        .map_err(|err| ProveError::SealEncodingFailed(err.to_string()))
}

fn ensure_dev_mode_disabled(dev_mode_value: Option<&OsStr>) -> Result<(), ProveError> {
    if dev_mode_value.is_some() {
        return Err(ProveError::DevModeEnabled {
            variable: DEV_MODE_ENV_VAR,
        });
    }
    Ok(())
}

fn ensure_allowlisted_deployment(cluster: &str) -> Result<(), ProveError> {
    config::require_allowlisted_deployment(cluster).map_err(|_| {
        ProveError::ClusterNotAllowlisted {
            cluster: cluster.to_string(),
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "production-prover")]
    use borsh::BorshDeserialize;

    // -------------------------------------------------------------------
    // Core proof generation tests
    // -------------------------------------------------------------------

    #[cfg(feature = "production-prover")]
    #[test]
    fn canonical_seal_shape_and_lengths_are_correct() {
        let request = default_prove_request();
        let response =
            generate_proof_with_dev_mode(&request, None).expect("proof generation must succeed");

        assert_eq!(response.seal_bytes.len(), SEAL_BYTES_LEN);
        let decoded = Seal::try_from_slice(&response.seal_bytes)
            .expect("seal bytes must decode via canonical borsh");
        assert_eq!(decoded.selector, TRUSTED_SEAL_SELECTOR);
        assert_eq!(response.journal.len(), JOURNAL_TOTAL_LEN);
        assert_eq!(response.image_id.len(), IMAGE_ID_LEN);
    }

    #[cfg(feature = "production-prover")]
    #[test]
    fn real_seal_bytes_decode_with_correct_selector() {
        let request = default_prove_request();
        let response =
            generate_proof_with_dev_mode(&request, None).expect("proof generation must succeed");
        let decoded = Seal::try_from_slice(&response.seal_bytes).expect("seal bytes must decode");
        assert_eq!(decoded.selector, TRUSTED_SEAL_SELECTOR);
    }

    #[cfg(feature = "production-prover")]
    #[test]
    fn proof_generation_is_deterministic() {
        let request = default_prove_request();

        let first = generate_proof_with_dev_mode(&request, None).expect("first run must succeed");
        let second = generate_proof_with_dev_mode(&request, None).expect("second run must succeed");

        #[cfg(not(feature = "production-prover"))]
        assert_eq!(first, second);

        // Real prover: journal and image_id are deterministic, seal may vary
        #[cfg(feature = "production-prover")]
        {
            assert_eq!(first.journal, second.journal);
            assert_eq!(first.image_id, second.image_id);
        }
    }

    #[test]
    fn dev_mode_guard_is_fail_closed() {
        let request = default_prove_request();
        let err = generate_proof_with_dev_mode(&request, Some(OsStr::new("1")))
            .expect_err("dev mode must be rejected");

        assert_eq!(
            err,
            ProveError::DevModeEnabled {
                variable: DEV_MODE_ENV_VAR,
            }
        );
    }

    #[cfg(feature = "production-prover")]
    #[test]
    fn cli_output_is_structured_and_deterministic() {
        let request = default_prove_request();

        let first = prove_cli_output(&request).expect("first render must succeed");
        let second = prove_cli_output(&request).expect("second render must succeed");

        #[cfg(not(feature = "production-prover"))]
        assert_eq!(first, second);

        assert!(first.starts_with("{\"seal_bytes\":["));
        assert!(first.contains(",\"journal\":["));
        assert!(first.contains(",\"image_id\":["));
        assert!(first.ends_with("]}"));
    }

    #[test]
    fn without_production_prover_returns_error() {
        #[cfg(not(feature = "production-prover"))]
        {
            let request = default_prove_request();
            let err = generate_proof_with_dev_mode(&request, None)
                .expect_err("must fail without production-prover");
            match err {
                ProveError::ProverFailed(msg) => {
                    assert!(msg.contains("--features production-prover"), "error should mention feature flag: {msg}");
                }
                other => panic!("expected ProverFailed, got: {other}"),
            }
        }
    }

    #[test]
    fn deployment_allowlist_contains_expected_ids_and_provenance() {
        let deployment = config::require_allowlisted_deployment(config::DEFAULT_CLUSTER)
            .expect("default cluster must be allowlisted");

        assert_eq!(
            deployment.router_program_id,
            config::TRUSTED_ROUTER_PROGRAM_ID
        );
        assert_eq!(
            deployment.verifier_program_id,
            config::TRUSTED_VERIFIER_PROGRAM_ID
        );
        assert_eq!(deployment.provenance, config::DEPLOYMENT_PROVENANCE);
        assert_eq!(
            deployment.provenance_path,
            config::DEPLOYMENT_PROVENANCE_PATH
        );
    }

    #[test]
    fn deployment_allowlist_rejects_non_allowlisted_cluster() {
        let err = ensure_allowlisted_deployment("testnet")
            .expect_err("non-allowlisted cluster must be rejected");

        assert_eq!(
            err,
            ProveError::ClusterNotAllowlisted {
                cluster: "testnet".to_string(),
            }
        );
    }

    #[test]
    fn deployment_allowlist_accepts_devnet() {
        let deployment =
            config::require_allowlisted_deployment("devnet").expect("devnet must be allowlisted");

        assert_eq!(
            deployment.router_program_id,
            config::TRUSTED_ROUTER_PROGRAM_ID
        );
        assert_eq!(
            deployment.verifier_program_id,
            config::TRUSTED_VERIFIER_PROGRAM_ID
        );
    }

    #[test]
    fn deployment_allowlist_accepts_mainnet_beta() {
        let deployment = config::require_allowlisted_deployment("mainnet-beta")
            .expect("mainnet-beta must be allowlisted");

        assert_eq!(
            deployment.router_program_id,
            config::TRUSTED_ROUTER_PROGRAM_ID
        );
        assert_eq!(
            deployment.verifier_program_id,
            config::TRUSTED_VERIFIER_PROGRAM_ID
        );
    }

    // -------------------------------------------------------------------
    // Shared helper and error variant tests
    // -------------------------------------------------------------------

    #[test]
    fn from_prove_request_produces_matching_journal_fields() {
        let request = default_prove_request();
        let fields = JournalFields::from(request);
        assert_eq!(fields.task_pda, request.task_pda);
        assert_eq!(fields.agent_authority, request.agent_authority);
        assert_eq!(fields.constraint_hash, request.constraint_hash);
        assert_eq!(fields.output_commitment, request.output_commitment);
        assert_eq!(fields.binding, request.binding);
        assert_eq!(fields.nullifier, request.nullifier);
    }

    #[test]
    fn guest_id_to_image_id_converts_le_words_correctly() {
        let guest_id: [u32; 8] = [
            0x04030201, 0x08070605, 0x0c0b0a09, 0x100f0e0d, 0x14131211, 0x18171615, 0x1c1b1a19,
            0x201f1e1d,
        ];
        let image_id = guest_id_to_image_id(&guest_id);

        // Each u32 is laid out in LE: 0x04030201 -> [0x01, 0x02, 0x03, 0x04]
        assert_eq!(image_id[0], 0x01);
        assert_eq!(image_id[1], 0x02);
        assert_eq!(image_id[2], 0x03);
        assert_eq!(image_id[3], 0x04);
        assert_eq!(image_id[4], 0x05);
        assert_eq!(image_id[31], 0x20);
        assert_eq!(image_id.len(), IMAGE_ID_LEN);
    }

    #[test]
    fn guest_id_to_image_id_zeroes() {
        let guest_id: [u32; 8] = [0; 8];
        let image_id = guest_id_to_image_id(&guest_id);
        assert_eq!(image_id, [0u8; IMAGE_ID_LEN]);
    }

    #[test]
    fn prove_error_prover_failed_display() {
        let err = ProveError::ProverFailed("out of memory".into());
        assert_eq!(err.to_string(), "prover failed: out of memory");
    }

    #[test]
    fn prove_error_receipt_type_mismatch_display() {
        let err = ProveError::ReceiptTypeMismatch("expected Groth16 receipt".into());
        assert_eq!(
            err.to_string(),
            "receipt type mismatch: expected Groth16 receipt"
        );
    }

    // -------------------------------------------------------------------
    // Production-prover gated tests (require rzup + Docker)
    // -------------------------------------------------------------------

    #[cfg(feature = "production-prover")]
    mod production_prover_tests {
        use super::*;

        #[test]
        fn real_proof_has_correct_structure() {
            let request = default_prove_request();
            let response =
                generate_proof_real(&request).expect("real proof generation must succeed");

            assert_eq!(response.seal_bytes.len(), SEAL_BYTES_LEN);
            assert_eq!(response.journal.len(), JOURNAL_TOTAL_LEN);
            assert_eq!(response.image_id.len(), IMAGE_ID_LEN);

            // Journal matches expected serialization
            let expected_journal = serialize_journal(&JournalFields::from(request));
            assert_eq!(response.journal, expected_journal.to_vec());

            // Seal decodes with correct selector
            let decoded =
                Seal::try_from_slice(&response.seal_bytes).expect("seal bytes must decode");
            assert_eq!(decoded.selector, TRUSTED_SEAL_SELECTOR);
        }

        #[test]
        fn real_image_id_is_deterministic() {
            let id1 = guest_id_to_image_id(&agenc_zkvm_methods::AGENC_GUEST_ID);
            let id2 = guest_id_to_image_id(&agenc_zkvm_methods::AGENC_GUEST_ID);
            assert_eq!(id1, id2);
            assert_ne!(id1, [0u8; IMAGE_ID_LEN]);
        }
    }
}
