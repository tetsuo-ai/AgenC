use crate::errors::CoordinationError;
use crate::state::HASH_SIZE;
use anchor_lang::prelude::*;

pub fn require_nonzero_image_id(image_id: &[u8; HASH_SIZE]) -> Result<()> {
    require!(
        *image_id != [0u8; HASH_SIZE],
        CoordinationError::InvalidImageId
    );
    Ok(())
}
