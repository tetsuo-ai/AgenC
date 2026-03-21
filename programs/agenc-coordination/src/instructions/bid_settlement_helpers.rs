use crate::errors::CoordinationError;
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::state::{
    BidBookState, BidderMarketState, DependencyType, Task, TaskBid, TaskBidBook, TaskBidState,
    TaskClaim, TaskType,
};
use anchor_lang::prelude::*;

pub(crate) struct BidTaskCompletionMeta {
    pub settlement_offset: usize,
    pub accepted_bid_price: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcceptedBidBookDisposition {
    Close,
    Reopen,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcceptedBidBondDisposition {
    Refund,
    FullSlashToCreator,
    SlashByBpsToCreator(u16),
}

fn bid_settlement_offset(task: &Task) -> usize {
    match task.dependency_type {
        DependencyType::Proof => 1,
        _ => 0,
    }
}

fn validate_bid_settlement_accounts<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book: &Account<'info, TaskBidBook>,
    accepted_bid: &Account<'info, TaskBid>,
    bidder_market_state: &Account<'info, BidderMarketState>,
    bidder_authority_info: &AccountInfo<'info>,
) -> Result<()> {
    require!(bid_book.task == *task_key, CoordinationError::InvalidInput);
    require!(
        bid_book.state == BidBookState::Accepted,
        CoordinationError::BidBookNotAccepted
    );
    require!(
        accepted_bid.task == *task_key,
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.bid_book == bid_book.key(),
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.bidder == claim.worker,
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.state == TaskBidState::Accepted,
        CoordinationError::BidBookNotAccepted
    );
    require!(
        bid_book.accepted_bid == Some(accepted_bid.key()),
        CoordinationError::BidBookNotAccepted
    );
    require!(
        bidder_market_state.bidder == claim.worker,
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.bidder_authority == bidder_authority_info.key(),
        CoordinationError::UnauthorizedAgent
    );
    Ok(())
}

fn load_accepted_bid_settlement_accounts<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book_info: &'info AccountInfo<'info>,
    accepted_bid_info: &'info AccountInfo<'info>,
    bidder_market_state_info: &'info AccountInfo<'info>,
    bidder_authority_info: &AccountInfo<'info>,
) -> Result<(
    Account<'info, TaskBidBook>,
    Account<'info, TaskBid>,
    Account<'info, BidderMarketState>,
)> {
    require!(
        bid_book_info.is_writable
            && accepted_bid_info.is_writable
            && bidder_market_state_info.is_writable
            && bidder_authority_info.is_writable,
        CoordinationError::InvalidInput
    );
    require!(
        bid_book_info.owner == &crate::ID
            && accepted_bid_info.owner == &crate::ID
            && bidder_market_state_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );

    let bid_book = Account::<TaskBidBook>::try_from(bid_book_info)?;
    let accepted_bid = Account::<TaskBid>::try_from(accepted_bid_info)?;
    let bidder_market_state = Account::<BidderMarketState>::try_from(bidder_market_state_info)?;

    validate_bid_settlement_accounts(
        task_key,
        claim,
        &bid_book,
        &accepted_bid,
        &bidder_market_state,
        bidder_authority_info,
    )?;

    Ok((bid_book, accepted_bid, bidder_market_state))
}

fn calculate_bid_bond_slash_amount(bond_lamports: u64, slash_bps: u16) -> Result<u64> {
    let slash_amount = bond_lamports
        .checked_mul(slash_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(slash_amount)
}

fn apply_bid_book_disposition(
    bid_book: &mut TaskBidBook,
    now: i64,
    disposition: AcceptedBidBookDisposition,
) -> Result<()> {
    bid_book.active_bids = bid_book
        .active_bids
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.state = match disposition {
        AcceptedBidBookDisposition::Close => BidBookState::Closed,
        AcceptedBidBookDisposition::Reopen => BidBookState::Open,
    };
    if disposition == AcceptedBidBookDisposition::Reopen {
        bid_book.accepted_bid = None;
    }
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;
    Ok(())
}

fn decrement_bidder_active_bid_count(bidder_market_state: &mut BidderMarketState) -> Result<()> {
    bidder_market_state.active_bid_count = bidder_market_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

fn account_info_at<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    index: usize,
) -> &'info AccountInfo<'info> {
    // SAFETY: each entry in `remaining_accounts` is already an `AccountInfo<'info>`.
    // We only need to rebind the reference itself to `'info` so Anchor account
    // wrappers can deserialize from it, matching the existing claim/escrow helpers.
    unsafe { std::mem::transmute(&remaining_accounts[index]) }
}

pub(crate) fn load_bid_task_completion_meta<'info>(
    task: &Task,
    task_key: &Pubkey,
    claim: &TaskClaim,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<Option<BidTaskCompletionMeta>> {
    if task.task_type != TaskType::BidExclusive {
        return Ok(None);
    }

    let offset = bid_settlement_offset(task);
    require!(
        remaining_accounts.len() >= offset + 4,
        CoordinationError::BidSettlementAccountsRequired
    );

    let bid_book_info = account_info_at(remaining_accounts, offset);
    let accepted_bid_info = account_info_at(remaining_accounts, offset + 1);
    let bidder_market_state_info = account_info_at(remaining_accounts, offset + 2);
    let bidder_authority_info = account_info_at(remaining_accounts, offset + 3);

    let (_, accepted_bid, _) = load_accepted_bid_settlement_accounts(
        task_key,
        claim,
        bid_book_info,
        accepted_bid_info,
        bidder_market_state_info,
        bidder_authority_info,
    )?;

    Ok(Some(BidTaskCompletionMeta {
        settlement_offset: offset,
        accepted_bid_price: accepted_bid.requested_reward_lamports,
    }))
}

pub(crate) fn finalize_bid_task_completion<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    task_key: &Pubkey,
    claim: &TaskClaim,
    meta: &BidTaskCompletionMeta,
    now: i64,
) -> Result<()> {
    let bid_book_info = account_info_at(remaining_accounts, meta.settlement_offset);
    let accepted_bid_info = account_info_at(remaining_accounts, meta.settlement_offset + 1);
    let bidder_market_state_info = account_info_at(remaining_accounts, meta.settlement_offset + 2);
    let bidder_authority_info = account_info_at(remaining_accounts, meta.settlement_offset + 3);

    settle_accepted_bid(
        task_key,
        claim,
        bid_book_info,
        accepted_bid_info,
        bidder_market_state_info,
        bidder_authority_info.clone(),
        None,
        now,
        AcceptedBidBookDisposition::Close,
        AcceptedBidBondDisposition::Refund,
    )?;

    Ok(())
}

pub(crate) fn close_bid_book_without_accepted_bid<'info>(
    task_key: &Pubkey,
    bid_book_info: &'info AccountInfo<'info>,
    now: i64,
) -> Result<()> {
    require!(bid_book_info.is_writable, CoordinationError::InvalidInput);
    require!(
        bid_book_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );

    let mut bid_book = Account::<TaskBidBook>::try_from(bid_book_info)?;
    require!(bid_book.task == *task_key, CoordinationError::InvalidInput);

    bid_book.state = BidBookState::Closed;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    Ok(())
}

pub(crate) fn settle_accepted_bid<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book_info: &'info AccountInfo<'info>,
    accepted_bid_info: &'info AccountInfo<'info>,
    bidder_market_state_info: &'info AccountInfo<'info>,
    bidder_authority_info: AccountInfo<'info>,
    creator_info: Option<AccountInfo<'info>>,
    now: i64,
    book_disposition: AcceptedBidBookDisposition,
    bond_disposition: AcceptedBidBondDisposition,
) -> Result<()> {
    let (mut bid_book, mut accepted_bid, mut bidder_market_state) =
        load_accepted_bid_settlement_accounts(
            task_key,
            claim,
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            &bidder_authority_info,
        )?;

    let slash_amount = match bond_disposition {
        AcceptedBidBondDisposition::Refund => 0,
        AcceptedBidBondDisposition::FullSlashToCreator => accepted_bid.bond_lamports,
        AcceptedBidBondDisposition::SlashByBpsToCreator(slash_bps) => {
            calculate_bid_bond_slash_amount(accepted_bid.bond_lamports, slash_bps)?
        }
    };

    if slash_amount > 0 {
        let creator_info = creator_info.ok_or(CoordinationError::InvalidCreator)?;
        require!(creator_info.is_writable, CoordinationError::InvalidInput);
        transfer_lamports(accepted_bid_info, &creator_info, slash_amount)?;
    }

    apply_bid_book_disposition(&mut bid_book, now, book_disposition)?;
    decrement_bidder_active_bid_count(&mut bidder_market_state)?;

    accepted_bid.updated_at = now;
    accepted_bid.close(bidder_authority_info)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_bid_bond_slash_amount() {
        assert_eq!(
            calculate_bid_bond_slash_amount(1_000_000, 2_500).unwrap(),
            250_000
        );
        assert_eq!(calculate_bid_bond_slash_amount(1_000_000, 0).unwrap(), 0);
        assert_eq!(
            calculate_bid_bond_slash_amount(1_000_000, 10_000).unwrap(),
            1_000_000
        );
    }

    #[test]
    fn test_apply_bid_book_disposition_close_preserves_accepted_bid() {
        let accepted_bid = Pubkey::new_unique();
        let mut bid_book = TaskBidBook {
            state: BidBookState::Accepted,
            accepted_bid: Some(accepted_bid),
            version: 4,
            active_bids: 3,
            updated_at: 10,
            ..TaskBidBook::default()
        };

        apply_bid_book_disposition(&mut bid_book, 42, AcceptedBidBookDisposition::Close).unwrap();

        assert!(bid_book.state == BidBookState::Closed);
        assert_eq!(bid_book.accepted_bid, Some(accepted_bid));
        assert_eq!(bid_book.active_bids, 2);
        assert_eq!(bid_book.version, 5);
        assert_eq!(bid_book.updated_at, 42);
    }

    #[test]
    fn test_apply_bid_book_disposition_reopen_clears_accepted_bid() {
        let mut bid_book = TaskBidBook {
            state: BidBookState::Accepted,
            accepted_bid: Some(Pubkey::new_unique()),
            version: 9,
            active_bids: 1,
            updated_at: 10,
            ..TaskBidBook::default()
        };

        apply_bid_book_disposition(&mut bid_book, 77, AcceptedBidBookDisposition::Reopen).unwrap();

        assert!(bid_book.state == BidBookState::Open);
        assert_eq!(bid_book.accepted_bid, None);
        assert_eq!(bid_book.active_bids, 0);
        assert_eq!(bid_book.version, 10);
        assert_eq!(bid_book.updated_at, 77);
    }
}
