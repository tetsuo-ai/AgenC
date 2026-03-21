//! Marketplace V2 bid-book instructions.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::CoordinationError;
use crate::events::{
    BidAccepted, BidBookInitialized, BidCancelled, BidCreated, BidExpired,
    BidMarketplaceInitialized, BidUpdated, TaskClaimed,
};
use crate::state::{
    AgentRegistration, AgentStatus, BidBookState, BidMarketplaceConfig, BidderMarketState,
    MatchingPolicy, ProtocolConfig, Task, TaskBid, TaskBidBook, TaskBidState, TaskClaim,
    TaskStatus, TaskType, WeightedScoreWeights,
};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use crate::utils::version::check_version_compatible;

const BID_WINDOW_SECONDS: i64 = 86_400;
const COMPLETION_BUFFER: i64 = 3_600;
const MAX_CONFIDENCE_BPS: u16 = 10_000;
const MAX_ACTIVE_TASKS: u16 = 10;

fn require_bid_task(task: &Task) -> Result<()> {
    require!(
        task.task_type == TaskType::BidExclusive,
        CoordinationError::TaskNotBidExclusive
    );
    require!(
        task.max_workers == 1,
        CoordinationError::BidExclusiveRequiresSingleWorker
    );
    require!(
        task.reward_mint.is_none(),
        CoordinationError::BidTaskSolOnly
    );
    Ok(())
}

fn parse_matching_policy(
    policy: u8,
    price_weight_bps: u16,
    eta_weight_bps: u16,
    confidence_weight_bps: u16,
    reliability_weight_bps: u16,
) -> Result<(MatchingPolicy, WeightedScoreWeights)> {
    let policy = match policy {
        0 => MatchingPolicy::BestPrice,
        1 => MatchingPolicy::BestEta,
        2 => MatchingPolicy::WeightedScore,
        _ => return Err(CoordinationError::InvalidMatchingPolicy.into()),
    };

    let weights = if policy == MatchingPolicy::WeightedScore {
        let total = price_weight_bps
            .checked_add(eta_weight_bps)
            .and_then(|v| v.checked_add(confidence_weight_bps))
            .and_then(|v| v.checked_add(reliability_weight_bps))
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            total == MAX_CONFIDENCE_BPS,
            CoordinationError::InvalidWeightedScoreWeights
        );
        WeightedScoreWeights {
            price_weight_bps,
            eta_weight_bps,
            confidence_weight_bps,
            reliability_weight_bps,
        }
    } else {
        WeightedScoreWeights::default()
    };

    Ok((policy, weights))
}

fn refresh_bid_window(state: &mut BidderMarketState, now: i64) {
    if state.bid_window_started_at == 0
        || now.saturating_sub(state.bid_window_started_at) >= BID_WINDOW_SECONDS
    {
        state.bid_window_started_at = now;
        state.bids_created_in_window = 0;
    }
}

#[derive(Accounts)]
pub struct InitializeBidMarketplace<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = BidMarketplaceConfig::SIZE,
        seeds = [b"bid_marketplace"],
        bump
    )]
    pub bid_marketplace: Account<'info, BidMarketplaceConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn initialize_bid_marketplace_handler(
    ctx: Context<InitializeBidMarketplace>,
    min_bid_bond_lamports: u64,
    bid_creation_cooldown_secs: i64,
    max_bids_per_24h: u16,
    max_active_bids_per_task: u16,
    max_bid_lifetime_secs: i64,
    accepted_no_show_slash_bps: u16,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    require!(
        min_bid_bond_lamports > 0,
        CoordinationError::InsufficientFunds
    );
    require!(
        bid_creation_cooldown_secs >= 0 && max_bid_lifetime_secs > 0,
        CoordinationError::InvalidCooldown
    );
    require!(
        max_bids_per_24h > 0,
        CoordinationError::RateLimitBelowMinimum
    );
    require!(
        max_active_bids_per_task > 0,
        CoordinationError::BidBookCapacityReached
    );
    require!(
        accepted_no_show_slash_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidSlashAmount
    );

    let config = &mut ctx.accounts.bid_marketplace;
    config.authority = ctx.accounts.protocol_config.authority;
    config.min_bid_bond_lamports = min_bid_bond_lamports;
    config.bid_creation_cooldown_secs = bid_creation_cooldown_secs;
    config.max_bids_per_24h = max_bids_per_24h;
    config.max_active_bids_per_task = max_active_bids_per_task;
    config.max_bid_lifetime_secs = max_bid_lifetime_secs;
    config.accepted_no_show_slash_bps = accepted_no_show_slash_bps;
    config.bump = ctx.bumps.bid_marketplace;

    emit!(BidMarketplaceInitialized {
        authority: config.authority,
        min_bid_bond_lamports,
        bid_creation_cooldown_secs,
        max_bids_per_24h,
        max_active_bids_per_task,
        max_bid_lifetime_secs,
        accepted_no_show_slash_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateBidMarketplaceConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace.bump
    )]
    pub bid_marketplace: Account<'info, BidMarketplaceConfig>,

    pub authority: Signer<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn update_bid_marketplace_config_handler(
    ctx: Context<UpdateBidMarketplaceConfig>,
    min_bid_bond_lamports: u64,
    bid_creation_cooldown_secs: i64,
    max_bids_per_24h: u16,
    max_active_bids_per_task: u16,
    max_bid_lifetime_secs: i64,
    accepted_no_show_slash_bps: u16,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    require!(
        min_bid_bond_lamports > 0,
        CoordinationError::InsufficientFunds
    );
    require!(
        bid_creation_cooldown_secs >= 0 && max_bid_lifetime_secs > 0,
        CoordinationError::InvalidCooldown
    );
    require!(
        max_bids_per_24h > 0,
        CoordinationError::RateLimitBelowMinimum
    );
    require!(
        max_active_bids_per_task > 0,
        CoordinationError::BidBookCapacityReached
    );
    require!(
        accepted_no_show_slash_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidSlashAmount
    );

    let config = &mut ctx.accounts.bid_marketplace;
    config.authority = ctx.accounts.protocol_config.authority;
    config.min_bid_bond_lamports = min_bid_bond_lamports;
    config.bid_creation_cooldown_secs = bid_creation_cooldown_secs;
    config.max_bids_per_24h = max_bids_per_24h;
    config.max_active_bids_per_task = max_active_bids_per_task;
    config.max_bid_lifetime_secs = max_bid_lifetime_secs;
    config.accepted_no_show_slash_bps = accepted_no_show_slash_bps;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeBidBook<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        init,
        payer = creator,
        space = TaskBidBook::SIZE,
        seeds = [b"bid_book", task.key().as_ref()],
        bump
    )]
    pub bid_book: Account<'info, TaskBidBook>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn initialize_bid_book_handler(
    ctx: Context<InitializeBidBook>,
    policy: u8,
    price_weight_bps: u16,
    eta_weight_bps: u16,
    confidence_weight_bps: u16,
    reliability_weight_bps: u16,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        ctx.accounts.task.current_workers == 0,
        CoordinationError::TaskFullyClaimed
    );
    let (policy, weights) = parse_matching_policy(
        policy,
        price_weight_bps,
        eta_weight_bps,
        confidence_weight_bps,
        reliability_weight_bps,
    )?;
    let now = Clock::get()?.unix_timestamp;

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.task = ctx.accounts.task.key();
    bid_book.state = BidBookState::Open;
    bid_book.policy = policy;
    bid_book.weights = weights;
    bid_book.accepted_bid = None;
    bid_book.version = 0;
    bid_book.total_bids = 0;
    bid_book.active_bids = 0;
    bid_book.created_at = now;
    bid_book.updated_at = now;
    bid_book.bump = ctx.bumps.bid_book;

    emit!(BidBookInitialized {
        task: ctx.accounts.task.key(),
        bid_book: bid_book.key(),
        state: bid_book.state as u8,
        policy: bid_book.policy as u8,
        book_version: bid_book.version,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CreateBid<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace.bump
    )]
    pub bid_marketplace: Box<Account<'info, BidMarketplaceConfig>>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        init,
        payer = authority,
        space = TaskBid::SIZE,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        init_if_needed,
        payer = authority,
        space = BidderMarketState::SIZE,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        mut,
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn create_bid_handler(
    ctx: Context<CreateBid>,
    requested_reward_lamports: u64,
    eta_seconds: u32,
    confidence_bps: u16,
    quality_guarantee_hash: [u8; 32],
    metadata_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        ctx.accounts.bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.bidder.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        (ctx.accounts.bidder.capabilities & ctx.accounts.task.required_capabilities)
            == ctx.accounts.task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );
    if ctx.accounts.task.min_reputation > 0 {
        require!(
            ctx.accounts.bidder.reputation >= ctx.accounts.task.min_reputation,
            CoordinationError::InsufficientReputation
        );
    }
    require!(
        requested_reward_lamports > 0,
        CoordinationError::InvalidReward
    );
    require!(
        requested_reward_lamports <= ctx.accounts.task.reward_amount,
        CoordinationError::BidPriceExceedsTaskBudget
    );
    require!(eta_seconds > 0, CoordinationError::InvalidBidEta);
    require!(
        confidence_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidBidConfidence
    );

    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, CoordinationError::InvalidBidExpiry);
    if ctx.accounts.task.deadline > 0 {
        require!(
            expires_at <= ctx.accounts.task.deadline,
            CoordinationError::InvalidBidExpiry
        );
    }
    require!(
        expires_at.saturating_sub(now) <= ctx.accounts.bid_marketplace.max_bid_lifetime_secs,
        CoordinationError::InvalidBidExpiry
    );
    require!(
        ctx.accounts.bid_book.active_bids < ctx.accounts.bid_marketplace.max_active_bids_per_task,
        CoordinationError::BidBookCapacityReached
    );

    let bidder_state = &mut ctx.accounts.bidder_market_state;
    if bidder_state.bidder == Pubkey::default() {
        bidder_state.bidder = ctx.accounts.bidder.key();
        bidder_state.bump = ctx.bumps.bidder_market_state;
    }
    refresh_bid_window(bidder_state, now);
    if bidder_state.last_bid_created_at > 0 {
        require!(
            now.saturating_sub(bidder_state.last_bid_created_at)
                >= ctx.accounts.bid_marketplace.bid_creation_cooldown_secs,
            CoordinationError::CooldownNotElapsed
        );
    }
    require!(
        bidder_state.bids_created_in_window < ctx.accounts.bid_marketplace.max_bids_per_24h,
        CoordinationError::RateLimitExceeded
    );

    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();
    let bid_account_info = ctx.accounts.bid.to_account_info();
    let bond_lamports = ctx.accounts.bid_marketplace.min_bid_bond_lamports;

    let bid = &mut ctx.accounts.bid;
    bid.task = task_key;
    bid.bid_book = bid_book_key;
    bid.bidder = bidder_key;
    bid.bidder_authority = ctx.accounts.authority.key();
    bid.requested_reward_lamports = requested_reward_lamports;
    bid.eta_seconds = eta_seconds;
    bid.confidence_bps = confidence_bps;
    bid.reputation_snapshot_bps = ctx.accounts.bidder.reputation;
    bid.quality_guarantee_hash = quality_guarantee_hash;
    bid.metadata_hash = metadata_hash;
    bid.expires_at = expires_at;
    bid.created_at = now;
    bid.updated_at = now;
    bid.state = TaskBidState::Active;
    bid.bond_lamports = bond_lamports;
    bid.bump = ctx.bumps.bid;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: bid_account_info,
            },
        ),
        bid.bond_lamports,
    )?;

    bidder_state.last_bid_created_at = now;
    bidder_state.bids_created_in_window = bidder_state
        .bids_created_in_window
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bidder_state.active_bid_count = bidder_state
        .active_bid_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bidder_state.total_bids_created = bidder_state
        .total_bids_created
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.total_bids = bid_book
        .total_bids
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.active_bids = bid_book
        .active_bids
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    emit!(BidCreated {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        requested_reward_lamports,
        eta_seconds,
        expires_at,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateBid<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Account<'info, TaskBidBook>,

    #[account(
        mut,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bid_book == bid_book.key() @ CoordinationError::InvalidInput
    )]
    pub bid: Account<'info, TaskBid>,

    #[account(
        mut,
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub bidder: Account<'info, AgentRegistration>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace.bump
    )]
    pub bid_marketplace: Account<'info, BidMarketplaceConfig>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

#[allow(clippy::too_many_arguments)]
pub fn update_bid_handler(
    ctx: Context<UpdateBid>,
    requested_reward_lamports: u64,
    eta_seconds: u32,
    confidence_bps: u16,
    quality_guarantee_hash: [u8; 32],
    metadata_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.bid.state == TaskBidState::Active,
        CoordinationError::BidNotActive
    );
    require!(
        ctx.accounts.bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        requested_reward_lamports > 0,
        CoordinationError::InvalidReward
    );
    require!(
        requested_reward_lamports <= ctx.accounts.task.reward_amount,
        CoordinationError::BidPriceExceedsTaskBudget
    );
    require!(eta_seconds > 0, CoordinationError::InvalidBidEta);
    require!(
        confidence_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidBidConfidence
    );
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, CoordinationError::InvalidBidExpiry);
    if ctx.accounts.task.deadline > 0 {
        require!(
            expires_at <= ctx.accounts.task.deadline,
            CoordinationError::InvalidBidExpiry
        );
    }
    require!(
        expires_at.saturating_sub(now) <= ctx.accounts.bid_marketplace.max_bid_lifetime_secs,
        CoordinationError::InvalidBidExpiry
    );

    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();

    let bid = &mut ctx.accounts.bid;
    bid.requested_reward_lamports = requested_reward_lamports;
    bid.eta_seconds = eta_seconds;
    bid.confidence_bps = confidence_bps;
    bid.reputation_snapshot_bps = ctx.accounts.bidder.reputation;
    bid.quality_guarantee_hash = quality_guarantee_hash;
    bid.metadata_hash = metadata_hash;
    bid.expires_at = expires_at;
    bid.updated_at = now;

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    emit!(BidUpdated {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        requested_reward_lamports,
        eta_seconds,
        expires_at,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelBid<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Account<'info, TaskBidBook>,

    #[account(
        mut,
        close = authority,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder_authority == authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub bid: Account<'info, TaskBid>,

    #[account(
        mut,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump = bidder_market_state.bump,
        constraint = bidder_market_state.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bidder_market_state: Account<'info, BidderMarketState>,

    #[account(
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Account<'info, AgentRegistration>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn cancel_bid_handler(ctx: Context<CancelBid>) -> Result<()> {
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.bid.state == TaskBidState::Active,
        CoordinationError::BidNotActive
    );
    require!(
        matches!(
            ctx.accounts.bid_book.state,
            BidBookState::Open | BidBookState::Accepted
        ),
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.bid_book.accepted_bid != Some(ctx.accounts.bid.key()),
        CoordinationError::BidAlreadyAccepted
    );

    let now = Clock::get()?.unix_timestamp;
    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();
    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.active_bids = bid_book
        .active_bids
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    let bidder_state = &mut ctx.accounts.bidder_market_state;
    bidder_state.active_bid_count = bidder_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(BidCancelled {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptBid<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        init,
        payer = creator,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        mut,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bid_book == bid_book.key() @ CoordinationError::InvalidInput
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        mut,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump = bidder_market_state.bump,
        constraint = bidder_market_state.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        mut,
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn accept_bid_handler(ctx: Context<AcceptBid>) -> Result<()> {
    let task = &mut ctx.accounts.task;
    let bid = &mut ctx.accounts.bid;
    let bid_book = &mut ctx.accounts.bid_book;
    let bidder = &mut ctx.accounts.bidder;
    let bidder_state = &mut ctx.accounts.bidder_market_state;
    let claim = &mut ctx.accounts.claim;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;
    require_bid_task(task)?;
    require!(
        task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        task.current_workers == 0,
        CoordinationError::TaskFullyClaimed
    );
    require!(
        bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(
        bid.state == TaskBidState::Active,
        CoordinationError::BidNotActive
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now < bid.expires_at, CoordinationError::TaskExpired);
    require!(
        bidder.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        (bidder.capabilities & task.required_capabilities) == task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );
    if task.min_reputation > 0 {
        require!(
            bidder.reputation >= task.min_reputation,
            CoordinationError::InsufficientReputation
        );
    }
    require!(
        bidder.active_tasks < MAX_ACTIVE_TASKS,
        CoordinationError::MaxActiveTasksReached
    );

    let expires_at = if task.deadline > 0 {
        task.deadline
            .checked_add(COMPLETION_BUFFER)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        now.checked_add(config.max_claim_duration)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    };

    claim.task = task.key();
    claim.worker = bidder.key();
    claim.claimed_at = now;
    claim.expires_at = expires_at;
    claim.completed_at = 0;
    claim.proof_hash = [0u8; 32];
    claim.result_data = [0u8; 64];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.reward_paid = 0;
    claim.bump = ctx.bumps.claim;

    bid.state = TaskBidState::Accepted;
    bid.updated_at = now;

    bid_book.state = BidBookState::Accepted;
    bid_book.accepted_bid = Some(bid.key());
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    task.current_workers = 1;
    task.status = TaskStatus::InProgress;

    bidder.active_tasks = bidder
        .active_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bidder.last_active = now;

    bidder_state.total_bids_accepted = bidder_state
        .total_bids_accepted
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(BidAccepted {
        task: task.key(),
        bid: bid.key(),
        bidder: bidder.key(),
        bid_book: bid_book.key(),
        book_version: bid_book.version,
        policy: bid_book.policy as u8,
        timestamp: now,
    });

    emit!(TaskClaimed {
        task_id: task.task_id,
        worker: bidder.key(),
        current_workers: task.current_workers,
        max_workers: task.max_workers,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExpireBid<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        mut,
        close = bidder_authority,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder_authority == bidder_authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        mut,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump = bidder_market_state.bump,
        constraint = bidder_market_state.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    /// CHECK: this must equal `bid.bidder_authority`, enforced by the account constraint above,
    /// and only receives lamports when the expired bid account is closed.
    #[account(mut)]
    pub bidder_authority: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn expire_bid_handler(ctx: Context<ExpireBid>) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.bid.state == TaskBidState::Active,
        CoordinationError::BidNotActive
    );

    let now = Clock::get()?.unix_timestamp;
    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();
    require!(
        now > ctx.accounts.bid.expires_at || ctx.accounts.bid_book.state == BidBookState::Closed,
        CoordinationError::BidNotExpired
    );

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.active_bids = bid_book
        .active_bids
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    let bidder_state = &mut ctx.accounts.bidder_market_state;
    bidder_state.active_bid_count = bidder_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(BidExpired {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        timestamp: now,
    });

    Ok(())
}
