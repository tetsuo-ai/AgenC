#![forbid(unsafe_code)]

use std::{ffi::OsStr, fmt};

pub mod config;

use agenc_zkvm_guest::{serialize_journal, JournalField, JournalFields, JOURNAL_TOTAL_LEN};
use borsh::BorshSerialize;
use verifier_router::{client::encode_seal_with_selector, Seal, Selector};

pub const IMAGE_ID_LEN: usize = 32;
pub const SEAL_SELECTOR_LEN: usize = 4;
pub const SEAL_PROOF_LEN: usize = 256;
pub const SEAL_BYTES_LEN: usize = SEAL_SELECTOR_LEN + SEAL_PROOF_LEN;
pub const TRUSTED_SEAL_SELECTOR: Selector = [0x52, 0x5a, 0x56, 0x4d];
pub const DEV_MODE_ENV_VAR: &str = "RISC0_DEV_MODE";

pub type ImageId = [u8; IMAGE_ID_LEN];
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

impl ProveRequest {
    fn as_journal_fields(&self) -> JournalFields {
        JournalFields {
            task_pda: self.task_pda,
            agent_authority: self.agent_authority,
            constraint_hash: self.constraint_hash,
            output_commitment: self.output_commitment,
            binding: self.binding,
            nullifier: self.nullifier,
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
    UnexpectedJournalLength { expected: usize, actual: usize },
    UntrustedSelector {
        expected: Selector,
        actual: Selector,
    },
    DevModeEnabled { variable: &'static str },
    ClusterNotAllowlisted { cluster: String },
    SealEncodingFailed(String),
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

    let journal_bytes = serialize_journal(&request.as_journal_fields());

    if journal_bytes.len() != JOURNAL_TOTAL_LEN {
        return Err(ProveError::UnexpectedJournalLength {
            expected: JOURNAL_TOTAL_LEN,
            actual: journal_bytes.len(),
        });
    }

    let image_id = derive_image_id(request);
    let proof_bytes = simulate_proof_bytes(&journal_bytes, &image_id);
    let seal_bytes = encode_seal(TRUSTED_SEAL_SELECTOR, &proof_bytes)?;

    Ok(ProveResponse {
        seal_bytes,
        journal: journal_bytes.to_vec(),
        image_id,
    })
}

pub fn prove_cli_output(request: &ProveRequest) -> Result<String, ProveError> {
    let response = generate_proof(request)?;
    Ok(render_prove_response(&response))
}

pub fn render_prove_response(response: &ProveResponse) -> String {
    format!(
        "{{\"seal_bytes\":{},\"journal\":{},\"image_id\":{}}}",
        format_byte_list(&response.seal_bytes),
        format_byte_list(&response.journal),
        format_byte_list(&response.image_id),
    )
}

fn derive_image_id(request: &ProveRequest) -> ImageId {
    let mut out = [0_u8; IMAGE_ID_LEN];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = request.constraint_hash[i]
            ^ request.binding[i].wrapping_add((i as u8).wrapping_mul(7));
    }
    out
}

fn simulate_proof_bytes(journal: &[u8; JOURNAL_TOTAL_LEN], image_id: &ImageId) -> ProofBytes {
    let mut out = [0_u8; SEAL_PROOF_LEN];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = journal[i % JOURNAL_TOTAL_LEN]
            ^ image_id[i % IMAGE_ID_LEN]
            ^ (i as u8).wrapping_mul(13);
    }
    out
}

fn encode_seal(
    selector: Selector,
    proof_bytes: &ProofBytes,
) -> Result<Vec<u8>, ProveError> {
    if selector != TRUSTED_SEAL_SELECTOR {
        return Err(ProveError::UntrustedSelector {
            expected: TRUSTED_SEAL_SELECTOR,
            actual: selector,
        });
    }

    let seal: Seal = encode_seal_with_selector(proof_bytes, selector);
    if seal.selector != TRUSTED_SEAL_SELECTOR {
        return Err(ProveError::UntrustedSelector {
            expected: TRUSTED_SEAL_SELECTOR,
            actual: seal.selector,
        });
    }

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
    config::require_allowlisted_deployment(cluster).map_err(|_| ProveError::ClusterNotAllowlisted {
        cluster: cluster.to_string(),
    })?;
    Ok(())
}

fn format_byte_list(bytes: &[u8]) -> String {
    let mut out = String::from("[");
    for (i, value) in bytes.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::BorshDeserialize;

    #[test]
    fn canonical_seal_shape_and_lengths_are_correct() {
        let request = default_prove_request();
        let response = generate_proof_with_dev_mode(&request, None)
            .expect("proof generation must succeed");

        assert_eq!(response.seal_bytes.len(), SEAL_BYTES_LEN);
        let decoded = Seal::try_from_slice(&response.seal_bytes)
            .expect("seal bytes must decode via canonical borsh");
        assert_eq!(decoded.selector, TRUSTED_SEAL_SELECTOR);
        assert_eq!(response.journal.len(), JOURNAL_TOTAL_LEN);
        assert_eq!(response.image_id.len(), IMAGE_ID_LEN);
    }

    #[test]
    fn canonical_seal_bytes_match_router_encoding() {
        let request = default_prove_request();
        let journal = serialize_journal(&request.as_journal_fields());
        let image_id = derive_image_id(&request);
        let proof_bytes = simulate_proof_bytes(&journal, &image_id);

        let expected_seal = encode_seal_with_selector(&proof_bytes, TRUSTED_SEAL_SELECTOR);
        let expected_bytes = expected_seal
            .try_to_vec()
            .expect("canonical seal must serialize");

        let response = generate_proof_with_dev_mode(&request, None)
            .expect("proof generation must succeed");
        assert_eq!(response.seal_bytes, expected_bytes);
    }

    #[test]
    fn proof_generation_is_deterministic() {
        let request = default_prove_request();

        let first = generate_proof_with_dev_mode(&request, None)
            .expect("first run must succeed");
        let second = generate_proof_with_dev_mode(&request, None)
            .expect("second run must succeed");

        assert_eq!(first, second);
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

    #[test]
    fn selector_enforcement_rejects_untrusted_selector() {
        let request = default_prove_request();
        let journal = serialize_journal(&request.as_journal_fields());
        let image_id = derive_image_id(&request);
        let proof_bytes = simulate_proof_bytes(&journal, &image_id);

        let err = encode_seal([0_u8; SEAL_SELECTOR_LEN], &proof_bytes)
            .expect_err("untrusted selector must be rejected");

        assert_eq!(
            err,
            ProveError::UntrustedSelector {
                expected: TRUSTED_SEAL_SELECTOR,
                actual: [0_u8; SEAL_SELECTOR_LEN],
            }
        );
    }

    #[test]
    fn cli_output_is_structured_and_deterministic() {
        let request = default_prove_request();

        let first = prove_cli_output(&request).expect("first render must succeed");
        let second = prove_cli_output(&request).expect("second render must succeed");

        assert_eq!(first, second);
        assert!(first.starts_with("{\"seal_bytes\":["));
        assert!(first.contains(",\"journal\":["));
        assert!(first.contains(",\"image_id\":["));
        assert!(first.ends_with("]}"));
    }

    #[test]
    fn deployment_allowlist_contains_expected_ids_and_provenance() {
        let deployment = config::require_allowlisted_deployment(config::DEFAULT_CLUSTER)
            .expect("default cluster must be allowlisted");

        assert_eq!(deployment.router_program_id, config::TRUSTED_ROUTER_PROGRAM_ID);
        assert_eq!(deployment.verifier_program_id, config::TRUSTED_VERIFIER_PROGRAM_ID);
        assert_eq!(deployment.provenance, config::DEPLOYMENT_PROVENANCE);
        assert_eq!(deployment.provenance_path, config::DEPLOYMENT_PROVENANCE_PATH);
    }

    #[test]
    fn deployment_allowlist_rejects_unknown_cluster() {
        let err = ensure_allowlisted_deployment("devnet")
            .expect_err("non-allowlisted cluster must be rejected");

        assert_eq!(
            err,
            ProveError::ClusterNotAllowlisted {
                cluster: "devnet".to_string(),
            }
        );
    }
}
