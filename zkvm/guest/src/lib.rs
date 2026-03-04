#![forbid(unsafe_code)]

pub const JOURNAL_FIELD_LEN: usize = 32;
pub const JOURNAL_FIELD_COUNT: usize = 6;
pub const JOURNAL_TOTAL_LEN: usize = 192;

pub type JournalField = [u8; JOURNAL_FIELD_LEN];
pub type JournalBytes = [u8; JOURNAL_TOTAL_LEN];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalFields {
    pub task_pda: JournalField,
    pub agent_authority: JournalField,
    pub constraint_hash: JournalField,
    pub output_commitment: JournalField,
    pub binding: JournalField,
    pub nullifier: JournalField,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalError {
    InvalidFieldLength {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
}

impl JournalFields {
    pub fn try_from_slices(
        task_pda: &[u8],
        agent_authority: &[u8],
        constraint_hash: &[u8],
        output_commitment: &[u8],
        binding: &[u8],
        nullifier: &[u8],
    ) -> Result<Self, JournalError> {
        Ok(Self {
            task_pda: copy_field("task_pda", task_pda)?,
            agent_authority: copy_field("agent_authority", agent_authority)?,
            constraint_hash: copy_field("constraint_hash", constraint_hash)?,
            output_commitment: copy_field("output_commitment", output_commitment)?,
            binding: copy_field("binding", binding)?,
            nullifier: copy_field("nullifier", nullifier)?,
        })
    }

    pub fn to_bytes(&self) -> JournalBytes {
        let mut out = [0_u8; JOURNAL_TOTAL_LEN];
        let fields: [&JournalField; JOURNAL_FIELD_COUNT] = [
            &self.task_pda,
            &self.agent_authority,
            &self.constraint_hash,
            &self.output_commitment,
            &self.binding,
            &self.nullifier,
        ];
        for (chunk, field) in out.chunks_exact_mut(JOURNAL_FIELD_LEN).zip(fields.iter()) {
            chunk.copy_from_slice(*field);
        }
        out
    }
}

pub fn serialize_journal(fields: &JournalFields) -> JournalBytes {
    fields.to_bytes()
}

pub fn placeholder_journal() -> JournalField {
    [0_u8; JOURNAL_FIELD_LEN]
}

fn copy_field(field: &'static str, value: &[u8]) -> Result<JournalField, JournalError> {
    if value.len() != JOURNAL_FIELD_LEN {
        return Err(JournalError::InvalidFieldLength {
            field,
            expected: JOURNAL_FIELD_LEN,
            actual: value.len(),
        });
    }

    let mut out = [0_u8; JOURNAL_FIELD_LEN];
    out.copy_from_slice(value);
    Ok(out)
}
