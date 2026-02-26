#![no_main]
#![forbid(unsafe_code)]

use agenc_zkvm_guest::{serialize_journal, JournalFields, JOURNAL_FIELD_LEN};
use risc0_zkvm::guest::env;

risc0_zkvm::entry!(main);

fn main() {
    let task_pda: [u8; JOURNAL_FIELD_LEN] = env::read();
    let agent_authority: [u8; JOURNAL_FIELD_LEN] = env::read();
    let constraint_hash: [u8; JOURNAL_FIELD_LEN] = env::read();
    let output_commitment: [u8; JOURNAL_FIELD_LEN] = env::read();
    let binding: [u8; JOURNAL_FIELD_LEN] = env::read();
    let nullifier: [u8; JOURNAL_FIELD_LEN] = env::read();
    let model_commitment: [u8; JOURNAL_FIELD_LEN] = env::read();
    let input_commitment: [u8; JOURNAL_FIELD_LEN] = env::read();

    // Match on-chain non-zero requirements (complete_task_private.rs)
    let zero = [0u8; JOURNAL_FIELD_LEN];
    assert!(output_commitment != zero, "output_commitment must be non-zero");
    assert!(binding != zero, "binding must be non-zero");
    assert!(nullifier != zero, "nullifier must be non-zero");

    let fields = JournalFields {
        task_pda,
        agent_authority,
        constraint_hash,
        output_commitment,
        binding,
        nullifier,
        model_commitment,
        input_commitment,
    };
    env::commit_slice(&serialize_journal(&fields));
}
