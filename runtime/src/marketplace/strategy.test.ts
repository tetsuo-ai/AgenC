import { describe, expect, it } from 'vitest';
import {
  AutonomousBidder,
  BalancedBidStrategy,
  ConservativeBidStrategy,
} from './strategy.js';
import { TaskBidMarketplace } from './engine.js';

describe('marketplace strategies', () => {
  it('conservative strategy bids higher reward and slower ETA than balanced', () => {
    const conservative = new ConservativeBidStrategy();
    const balanced = new BalancedBidStrategy();

    const context = {
      taskId: 'task-1',
      bidderId: 'agent-1',
      maxRewardLamports: 1_000n,
      etaSeconds: 120,
      confidenceBps: 6_500,
      reliabilityBps: 6_000,
      expiresAtMs: 10_000,
    };

    const cBid = conservative.buildBid(context);
    const bBid = balanced.buildBid(context);

    expect(cBid.rewardLamports).toBeGreaterThan(bBid.rewardLamports);
    expect(cBid.etaSeconds).toBeGreaterThanOrEqual(bBid.etaSeconds);
    expect(cBid.confidenceBps).toBeGreaterThanOrEqual(bBid.confidenceBps);
    expect(cBid.reliabilityBps).toBeGreaterThanOrEqual(bBid.reliabilityBps ?? 0);
  });

  it('autonomous bidder places bids through marketplace engine', () => {
    let nowMs = 1_000;
    const marketplace = new TaskBidMarketplace({
      now: () => nowMs,
      bidIdGenerator: (taskId, bidderId, seq) => `${taskId}:${bidderId}:${seq}`,
    });

    marketplace.setTaskOwner({ taskId: 'task-2', ownerId: 'creator' });

    const bidder = new AutonomousBidder({
      actorId: 'agent-1',
      strategy: new BalancedBidStrategy({ rewardFractionBps: 8_000 }),
      marketplace,
    });

    const placed = bidder.placeBid(
      {
        taskId: 'task-2',
        bidderId: 'agent-1',
        maxRewardLamports: 500n,
        etaSeconds: 60,
        confidenceBps: 7_000,
        expiresAtMs: 5_000,
      },
      { taskOwnerId: 'creator' },
    );

    expect(placed.bidderId).toBe('agent-1');
    expect(placed.rewardLamports).toBe(400n);

    nowMs = 1_200;
    const bids = marketplace.listBids({ taskId: 'task-2' });
    expect(bids).toHaveLength(1);
    expect(bids[0].bidId).toBe(placed.bidId);
  });

  it('fails when bidder context does not match actor authorization', () => {
    const marketplace = new TaskBidMarketplace();
    const bidder = new AutonomousBidder({
      actorId: 'agent-1',
      strategy: new BalancedBidStrategy(),
      marketplace,
    });

    expect(() =>
      bidder.placeBid({
        taskId: 'task-3',
        bidderId: 'agent-2',
        maxRewardLamports: 100n,
        etaSeconds: 30,
        confidenceBps: 8_000,
        expiresAtMs: 10_000,
      }),
    ).toThrow('cannot create bids for bidder');
  });
});
