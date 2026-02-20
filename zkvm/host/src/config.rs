#![forbid(unsafe_code)]

pub const DEFAULT_CLUSTER: &str = "localnet";

pub const TRUSTED_ROUTER_PROGRAM_ID: &str = "6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7";
pub const TRUSTED_VERIFIER_PROGRAM_ID: &str = "THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge";

pub const DEPLOYMENT_PROVENANCE: &str = "boundless-xyz/risc0-solana tag v3.0.0";
pub const DEPLOYMENT_PROVENANCE_PATH: &str =
    "solana-verifier/Anchor.toml and generated Solana clients";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedDeployment {
    pub cluster: &'static str,
    pub router_program_id: &'static str,
    pub verifier_program_id: &'static str,
    pub provenance: &'static str,
    pub provenance_path: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigError {
    ClusterNotAllowlisted,
}

// Program IDs are the same across clusters (deployed from boundless-xyz/risc0-solana tag v3.0.0)
pub const TRUSTED_DEPLOYMENTS: [TrustedDeployment; 3] = [
    TrustedDeployment {
        cluster: DEFAULT_CLUSTER,
        router_program_id: TRUSTED_ROUTER_PROGRAM_ID,
        verifier_program_id: TRUSTED_VERIFIER_PROGRAM_ID,
        provenance: DEPLOYMENT_PROVENANCE,
        provenance_path: DEPLOYMENT_PROVENANCE_PATH,
    },
    TrustedDeployment {
        cluster: "devnet",
        router_program_id: TRUSTED_ROUTER_PROGRAM_ID,
        verifier_program_id: TRUSTED_VERIFIER_PROGRAM_ID,
        provenance: DEPLOYMENT_PROVENANCE,
        provenance_path: DEPLOYMENT_PROVENANCE_PATH,
    },
    TrustedDeployment {
        cluster: "mainnet-beta",
        router_program_id: TRUSTED_ROUTER_PROGRAM_ID,
        verifier_program_id: TRUSTED_VERIFIER_PROGRAM_ID,
        provenance: DEPLOYMENT_PROVENANCE,
        provenance_path: DEPLOYMENT_PROVENANCE_PATH,
    },
];

pub fn require_allowlisted_deployment(cluster: &str) -> Result<&'static TrustedDeployment, ConfigError> {
    TRUSTED_DEPLOYMENTS
        .iter()
        .find(|deployment| deployment.cluster == cluster)
        .ok_or(ConfigError::ClusterNotAllowlisted)
}
