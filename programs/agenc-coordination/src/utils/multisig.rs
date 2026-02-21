//! Multisig approval helpers

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::CoordinationError;
use crate::state::ProtocolConfig;

/// Validate multisig owner pubkeys before config is written
pub fn validate_multisig_owners(owners: &[Pubkey]) -> Result<()> {
    for (index, owner) in owners.iter().enumerate() {
        require!(
            *owner != Pubkey::default(),
            CoordinationError::MultisigDefaultSigner
        );
        for other in owners.iter().skip(index + 1) {
            require!(*owner != *other, CoordinationError::MultisigDuplicateSigner);
        }
    }
    Ok(())
}

pub fn require_multisig(config: &ProtocolConfig, remaining_accounts: &[AccountInfo]) -> Result<()> {
    let owners_len = config.multisig_owners_len as usize;
    let threshold = config.multisig_threshold as usize;

    if owners_len == 0 || owners_len > ProtocolConfig::MAX_MULTISIG_OWNERS {
        return Err(error!(CoordinationError::MultisigInvalidSigners));
    }

    if threshold < 2 || threshold > owners_len {
        return Err(error!(CoordinationError::MultisigInvalidThreshold));
    }

    let mut approvals = 0usize;
    let mut seen_owner = [false; ProtocolConfig::MAX_MULTISIG_OWNERS];

    for account in remaining_accounts {
        if !account.is_signer {
            continue;
        }

        // Security: Validate that signer accounts are owned by the System Program
        // This prevents malicious actors from passing program-owned accounts with
        // manipulated is_signer flags. Only regular wallet accounts (System-owned)
        // can be valid multisig signers.
        if account.owner != &system_program::ID {
            return Err(error!(CoordinationError::MultisigSignerNotSystemOwned));
        }

        for (index, owner) in config.multisig_owners[..owners_len].iter().enumerate() {
            if owner == &Pubkey::default() {
                return Err(error!(CoordinationError::MultisigDefaultSigner));
            }

            if account.key == owner {
                if seen_owner[index] {
                    return Err(error!(CoordinationError::MultisigDuplicateSigner));
                }
                seen_owner[index] = true;
                approvals += 1;
            }
        }
    }

    if approvals < threshold {
        return Err(error!(CoordinationError::MultisigNotEnoughSigners));
    }

    Ok(())
}
