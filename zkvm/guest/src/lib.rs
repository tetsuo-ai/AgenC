#![forbid(unsafe_code)]

pub const JOURNAL_FIELD_LEN: usize = 32;
pub const JOURNAL_FIELD_COUNT: usize = 6;
pub const JOURNAL_TOTAL_LEN: usize = JOURNAL_FIELD_LEN * JOURNAL_FIELD_COUNT;

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
        out[0..32].copy_from_slice(&self.task_pda);
        out[32..64].copy_from_slice(&self.agent_authority);
        out[64..96].copy_from_slice(&self.constraint_hash);
        out[96..128].copy_from_slice(&self.output_commitment);
        out[128..160].copy_from_slice(&self.binding);
        out[160..192].copy_from_slice(&self.nullifier);
        out
    }
}

pub fn serialize_journal(fields: &JournalFields) -> JournalBytes {
    fields.to_bytes()
}

pub fn serialize_journal_from_slices(
    task_pda: &[u8],
    agent_authority: &[u8],
    constraint_hash: &[u8],
    output_commitment: &[u8],
    binding: &[u8],
    nullifier: &[u8],
) -> Result<JournalBytes, JournalError> {
    let fields = JournalFields::try_from_slices(
        task_pda,
        agent_authority,
        constraint_hash,
        output_commitment,
        binding,
        nullifier,
    )?;
    Ok(fields.to_bytes())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_output_length_is_exact() {
        assert_eq!(JOURNAL_FIELD_LEN, 32);
        assert_eq!(JOURNAL_FIELD_COUNT, 6);
        assert_eq!(JOURNAL_TOTAL_LEN, 192);

        let fields = JournalFields {
            task_pda: [1_u8; JOURNAL_FIELD_LEN],
            agent_authority: [2_u8; JOURNAL_FIELD_LEN],
            constraint_hash: [3_u8; JOURNAL_FIELD_LEN],
            output_commitment: [4_u8; JOURNAL_FIELD_LEN],
            binding: [5_u8; JOURNAL_FIELD_LEN],
            nullifier: [6_u8; JOURNAL_FIELD_LEN],
        };

        let journal = serialize_journal(&fields);
        assert_eq!(journal.len(), JOURNAL_TOTAL_LEN);
    }

    #[test]
    fn journal_field_order_matches_schema_offsets() {
        let fields = JournalFields {
            task_pda: [11_u8; JOURNAL_FIELD_LEN],
            agent_authority: [22_u8; JOURNAL_FIELD_LEN],
            constraint_hash: [33_u8; JOURNAL_FIELD_LEN],
            output_commitment: [44_u8; JOURNAL_FIELD_LEN],
            binding: [55_u8; JOURNAL_FIELD_LEN],
            nullifier: [66_u8; JOURNAL_FIELD_LEN],
        };

        let journal = serialize_journal(&fields);

        assert_eq!(&journal[0..32], &fields.task_pda);
        assert_eq!(&journal[32..64], &fields.agent_authority);
        assert_eq!(&journal[64..96], &fields.constraint_hash);
        assert_eq!(&journal[96..128], &fields.output_commitment);
        assert_eq!(&journal[128..160], &fields.binding);
        assert_eq!(&journal[160..192], &fields.nullifier);
    }

    #[test]
    fn malformed_input_is_rejected() {
        let ok = [1_u8; JOURNAL_FIELD_LEN];
        let short = [9_u8; JOURNAL_FIELD_LEN - 1];
        let long = [8_u8; JOURNAL_FIELD_LEN + 1];

        let err = serialize_journal_from_slices(
            &short,
            &ok,
            &ok,
            &ok,
            &ok,
            &ok,
        )
        .expect_err("short task_pda must fail");

        assert_eq!(
            err,
            JournalError::InvalidFieldLength {
                field: "task_pda",
                expected: JOURNAL_FIELD_LEN,
                actual: JOURNAL_FIELD_LEN - 1,
            }
        );

        let err = serialize_journal_from_slices(
            &ok,
            &ok,
            &ok,
            &ok,
            &ok,
            &long,
        )
        .expect_err("long nullifier must fail");

        assert_eq!(
            err,
            JournalError::InvalidFieldLength {
                field: "nullifier",
                expected: JOURNAL_FIELD_LEN,
                actual: JOURNAL_FIELD_LEN + 1,
            }
        );
    }
}
