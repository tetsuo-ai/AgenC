//! Borsh deserialization guards.
//!
//! GHSA-fjx5-qpf4-xjf2 is triggered by deserializing zero-sized types (ZSTs)
//! through Borsh. This helper provides a single guarded entrypoint for
//! `try_from_slice` in first-party code paths.

use anchor_lang::prelude::AnchorDeserialize;
use std::io::{Error, ErrorKind};

/// Deserialize a Borsh value while rejecting zero-sized target types.
pub fn try_from_slice_non_zst<T: AnchorDeserialize>(bytes: &[u8]) -> Result<T, Error> {
    if core::mem::size_of::<T>() == 0 {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "refusing to deserialize zero-sized type with Borsh",
        ));
    }
    T::try_from_slice(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::*;

    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
    struct NonZst {
        value: u8,
    }

    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
    struct EmptyZst {}

    #[test]
    fn rejects_zero_sized_type() {
        let err = try_from_slice_non_zst::<EmptyZst>(&[])
            .expect_err("zst deserialization must be rejected");
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn deserializes_non_zst_type() {
        let bytes = NonZst { value: 7 }.try_to_vec().expect("serialize");
        let parsed = try_from_slice_non_zst::<NonZst>(&bytes).expect("deserialize");
        assert_eq!(parsed, NonZst { value: 7 });
    }
}
