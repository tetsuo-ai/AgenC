import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { PROGRAM_ID } from '@agenc/sdk';
import { RuntimeErrorCodes } from '../types/errors.js';
import { ReputationScoringError, ReputationTrackingError } from './reputation-errors.js';
import { ReputationScorer } from './reputation.js';
import {
  ReputationReason,
  REPUTATION_MAX,
  REPUTATION_MIN,
  DEFAULT_UPVOTE_WEIGHT,
  DEFAULT_POST_WEIGHT,
  DEFAULT_COLLABORATION_WEIGHT,
  DEFAULT_MESSAGE_WEIGHT,
  DEFAULT_SPAM_PENALTY,
  DEFAULT_ON_CHAIN_WEIGHT,
  type SocialSignals,
  type ReputationChangeRecord,
} from './reputation-types.js';
import type { AgentProfile } from './types.js';
import type { FeedPost } from './feed-types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function randomBytes32(): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** Create a minimal mock program with addEventListener for event tracking. */
function createMockProgram() {
  const listeners = new Map<string, Function>();
  let listenerId = 0;

  return {
    programId: PROGRAM_ID,
    addEventListener: vi.fn((eventName: string, callback: Function) => {
      const id = listenerId++;
      listeners.set(`${eventName}:${id}`, callback);
      return id;
    }),
    removeEventListener: vi.fn().mockResolvedValue(undefined),
    _listeners: listeners,
    _emit(eventName: string, data: unknown, slot: number, signature: string) {
      for (const [key, cb] of listeners.entries()) {
        if (key.startsWith(`${eventName}:`)) {
          cb(data, slot, signature);
        }
      }
    },
  } as any;
}

function createScorer(overrides?: Record<string, unknown>) {
  const program = createMockProgram();
  const scorer = new ReputationScorer({
    program,
    ...overrides,
  });
  return { scorer, program };
}

function createMockAgentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    pda: randomPubkey(),
    agentId: randomBytes32(),
    authority: randomPubkey(),
    capabilities: 3n,
    status: 1,
    endpoint: 'https://agent.example.com',
    metadataUri: '',
    registeredAt: 1700000000,
    lastActive: 1700001000,
    tasksCompleted: 10n,
    totalEarned: 1_000_000_000n,
    reputation: 5000,
    activeTasks: 0,
    stake: 1_000_000_000n,
    ...overrides,
  };
}

function createMockFeedPost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    pda: randomPubkey(),
    author: randomPubkey(),
    contentHash: randomBytes32(),
    topic: randomBytes32(),
    parentPost: null,
    nonce: randomBytes32(),
    upvoteCount: 0,
    createdAt: 1700000000,
    ...overrides,
  };
}

function zeroSignals(): SocialSignals {
  return {
    postsAuthored: 0,
    upvotesReceived: 0,
    collaborationsCompleted: 0,
    messagesSent: 0,
    spamReports: 0,
  };
}

// ============================================================================
// Constants Tests
// ============================================================================

describe('ReputationReason constants', () => {
  it('matches on-chain values', () => {
    expect(ReputationReason.COMPLETION).toBe(0);
    expect(ReputationReason.DISPUTE_SLASH).toBe(1);
    expect(ReputationReason.DECAY).toBe(2);
  });

  it('has expected bound constants', () => {
    expect(REPUTATION_MAX).toBe(10_000);
    expect(REPUTATION_MIN).toBe(0);
  });

  it('has reasonable default weights', () => {
    expect(DEFAULT_UPVOTE_WEIGHT).toBe(5);
    expect(DEFAULT_POST_WEIGHT).toBe(2);
    expect(DEFAULT_COLLABORATION_WEIGHT).toBe(10);
    expect(DEFAULT_MESSAGE_WEIGHT).toBe(1);
    expect(DEFAULT_SPAM_PENALTY).toBe(50);
    expect(DEFAULT_ON_CHAIN_WEIGHT).toBe(0.7);
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe('ReputationScoringError', () => {
  it('has correct code and message', () => {
    const err = new ReputationScoringError('negative upvotes');
    expect(err.code).toBe(RuntimeErrorCodes.REPUTATION_SCORING_ERROR);
    expect(err.name).toBe('ReputationScoringError');
    expect(err.reason).toBe('negative upvotes');
    expect(err.message).toContain('negative upvotes');
  });
});

describe('ReputationTrackingError', () => {
  it('has correct code and message', () => {
    const err = new ReputationTrackingError('subscription failed');
    expect(err.code).toBe(RuntimeErrorCodes.REPUTATION_TRACKING_ERROR);
    expect(err.name).toBe('ReputationTrackingError');
    expect(err.reason).toBe('subscription failed');
    expect(err.message).toContain('subscription failed');
  });
});

// ============================================================================
// Individual Signal Scoring
// ============================================================================

describe('ReputationScorer — signal scoring', () => {
  let scorer: ReputationScorer;

  beforeEach(() => {
    ({ scorer } = createScorer());
  });

  describe('scorePost', () => {
    it('returns upvoteWeight * upvotes + postWeight', () => {
      expect(scorer.scorePost(0)).toBe(DEFAULT_POST_WEIGHT);
      expect(scorer.scorePost(1)).toBe(DEFAULT_UPVOTE_WEIGHT + DEFAULT_POST_WEIGHT);
      expect(scorer.scorePost(10)).toBe(10 * DEFAULT_UPVOTE_WEIGHT + DEFAULT_POST_WEIGHT);
    });

    it('throws on negative upvotes', () => {
      expect(() => scorer.scorePost(-1)).toThrow(ReputationScoringError);
    });
  });

  describe('scoreCollaboration', () => {
    it('returns collaborationWeight', () => {
      expect(scorer.scoreCollaboration(1)).toBe(DEFAULT_COLLABORATION_WEIGHT);
      expect(scorer.scoreCollaboration(5)).toBe(DEFAULT_COLLABORATION_WEIGHT);
    });

    it('throws on zero participants', () => {
      expect(() => scorer.scoreCollaboration(0)).toThrow(ReputationScoringError);
    });
  });

  describe('scoreMessage', () => {
    it('returns messageWeight', () => {
      expect(scorer.scoreMessage()).toBe(DEFAULT_MESSAGE_WEIGHT);
    });
  });

  describe('penalizeSpam', () => {
    it('returns negative spamPenaltyBase * severity', () => {
      expect(scorer.penalizeSpam(1)).toBe(-DEFAULT_SPAM_PENALTY);
      expect(scorer.penalizeSpam(2)).toBe(-2 * DEFAULT_SPAM_PENALTY);
      expect(scorer.penalizeSpam(0)).toBe(-0);
    });

    it('throws on negative severity', () => {
      expect(() => scorer.penalizeSpam(-1)).toThrow(ReputationScoringError);
    });
  });
});

// ============================================================================
// Custom Weights
// ============================================================================

describe('ReputationScorer — custom weights', () => {
  it('uses custom weights when provided', () => {
    const { scorer } = createScorer({
      weights: {
        upvoteWeight: 10,
        postWeight: 3,
        collaborationWeight: 20,
        messageWeight: 2,
        spamPenaltyBase: 100,
      },
    });

    expect(scorer.scorePost(5)).toBe(5 * 10 + 3);
    expect(scorer.scoreCollaboration(1)).toBe(20);
    expect(scorer.scoreMessage()).toBe(2);
    expect(scorer.penalizeSpam(1)).toBe(-100);
  });

  it('clamps onChainWeight to [0,1]', () => {
    const { scorer: s1 } = createScorer({ weights: { onChainWeight: 2 } });
    // onChainWeight clamped to 1.0 → composite = 1.0 * onChainRep + 0 * social
    expect(s1.computeCompositeScore(8000, 5000)).toBe(8000);

    const { scorer: s2 } = createScorer({ weights: { onChainWeight: -1 } });
    // onChainWeight clamped to 0.0 → composite = 0 * onChainRep + 1.0 * social
    expect(s2.computeCompositeScore(8000, 5000)).toBe(5000);
  });
});

// ============================================================================
// Aggregate Scoring
// ============================================================================

describe('ReputationScorer — aggregate scoring', () => {
  let scorer: ReputationScorer;

  beforeEach(() => {
    ({ scorer } = createScorer());
  });

  describe('computeSocialScore', () => {
    it('returns 0 for zero signals', () => {
      expect(scorer.computeSocialScore(zeroSignals())).toBe(0);
    });

    it('sums weighted signal counts', () => {
      const signals: SocialSignals = {
        postsAuthored: 5,
        upvotesReceived: 10,
        collaborationsCompleted: 2,
        messagesSent: 100,
        spamReports: 0,
      };
      const expected =
        5 * DEFAULT_POST_WEIGHT +
        10 * DEFAULT_UPVOTE_WEIGHT +
        2 * DEFAULT_COLLABORATION_WEIGHT +
        100 * DEFAULT_MESSAGE_WEIGHT;
      expect(scorer.computeSocialScore(signals)).toBe(expected);
    });

    it('subtracts spam penalty', () => {
      const signals: SocialSignals = {
        postsAuthored: 1,
        upvotesReceived: 0,
        collaborationsCompleted: 0,
        messagesSent: 0,
        spamReports: 1,
      };
      const raw = 1 * DEFAULT_POST_WEIGHT - 1 * DEFAULT_SPAM_PENALTY;
      // Clamped to 0
      expect(scorer.computeSocialScore(signals)).toBe(Math.max(0, raw));
    });

    it('clamps to zero floor', () => {
      const signals: SocialSignals = {
        postsAuthored: 0,
        upvotesReceived: 0,
        collaborationsCompleted: 0,
        messagesSent: 0,
        spamReports: 10,
      };
      expect(scorer.computeSocialScore(signals)).toBe(0);
    });
  });

  describe('computeCompositeScore', () => {
    it('returns on-chain reputation when social is 0', () => {
      // 0.7 * 5000 + 0.3 * 0 = 3500
      expect(scorer.computeCompositeScore(5000, 0)).toBe(3500);
    });

    it('blends on-chain and social scores', () => {
      // 0.7 * 5000 + 0.3 * 3000 = 3500 + 900 = 4400
      expect(scorer.computeCompositeScore(5000, 3000)).toBe(4400);
    });

    it('clamps to REPUTATION_MAX', () => {
      expect(scorer.computeCompositeScore(REPUTATION_MAX, REPUTATION_MAX)).toBe(REPUTATION_MAX);
      expect(scorer.computeCompositeScore(20000, 20000)).toBe(REPUTATION_MAX);
    });

    it('clamps to REPUTATION_MIN', () => {
      expect(scorer.computeCompositeScore(-100, 0)).toBe(0);
    });

    it('caps social score at REPUTATION_MAX before blending', () => {
      // social = 50000 normalized to 10000
      // 0.7 * 0 + 0.3 * 10000 = 3000
      expect(scorer.computeCompositeScore(0, 50000)).toBe(3000);
    });
  });
});

// ============================================================================
// Post Ranking
// ============================================================================

describe('ReputationScorer — rankPosts', () => {
  let scorer: ReputationScorer;

  beforeEach(() => {
    ({ scorer } = createScorer());
  });

  it('returns posts sorted by score descending', () => {
    const author1 = randomPubkey();
    const author2 = randomPubkey();
    const posts = [
      createMockFeedPost({ author: author1, upvoteCount: 5 }),
      createMockFeedPost({ author: author2, upvoteCount: 10 }),
    ];
    const reputationMap = new Map<string, number>([
      [author1.toBase58(), 5000],
      [author2.toBase58(), 5000],
    ]);

    const ranked = scorer.rankPosts(posts, reputationMap);
    expect(ranked).toHaveLength(2);
    // Post with 10 upvotes should rank higher
    expect(ranked[0].post.upvoteCount).toBe(10);
    expect(ranked[1].post.upvoteCount).toBe(5);
  });

  it('weights posts by author reputation', () => {
    const highRepAuthor = randomPubkey();
    const lowRepAuthor = randomPubkey();
    const posts = [
      createMockFeedPost({ author: lowRepAuthor, upvoteCount: 10 }),
      createMockFeedPost({ author: highRepAuthor, upvoteCount: 10 }),
    ];
    const reputationMap = new Map<string, number>([
      [highRepAuthor.toBase58(), 9000],
      [lowRepAuthor.toBase58(), 1000],
    ]);

    const ranked = scorer.rankPosts(posts, reputationMap);
    expect(ranked[0].authorReputation).toBe(9000);
    expect(ranked[1].authorReputation).toBe(1000);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('uses 0 reputation for unknown authors', () => {
    const post = createMockFeedPost({ upvoteCount: 5 });
    const ranked = scorer.rankPosts([post], new Map());
    expect(ranked[0].authorReputation).toBe(0);
    // rep multiplier = 1 + 0/10000 = 1.0
    expect(ranked[0].weightedUpvotes).toBe(5);
  });

  it('returns empty for empty input', () => {
    expect(scorer.rankPosts([], new Map())).toEqual([]);
  });
});

// ============================================================================
// Agent Ranking
// ============================================================================

describe('ReputationScorer — rankAgents', () => {
  let scorer: ReputationScorer;

  beforeEach(() => {
    ({ scorer } = createScorer());
  });

  it('sorts by composite score descending', () => {
    const agents = [
      createMockAgentProfile({ reputation: 3000 }),
      createMockAgentProfile({ reputation: 8000 }),
      createMockAgentProfile({ reputation: 5000 }),
    ];

    const ranked = scorer.rankAgents(agents);
    expect(ranked[0].onChainReputation).toBe(8000);
    expect(ranked[1].onChainReputation).toBe(5000);
    expect(ranked[2].onChainReputation).toBe(3000);
  });

  it('incorporates social signals when provided', () => {
    const lowRepAgent = createMockAgentProfile({ reputation: 2000 });
    const highRepAgent = createMockAgentProfile({ reputation: 7000 });
    const agents = [lowRepAgent, highRepAgent];

    // Give the low-rep agent massive social signals
    const signalsMap = new Map<string, SocialSignals>([
      [lowRepAgent.pda.toBase58(), {
        postsAuthored: 100,
        upvotesReceived: 500,
        collaborationsCompleted: 50,
        messagesSent: 1000,
        spamReports: 0,
      }],
    ]);

    const ranked = scorer.rankAgents(agents, signalsMap);
    // Low-rep agent should still have high composite score from social signals
    const lowRepResult = ranked.find(r => r.onChainReputation === 2000)!;
    expect(lowRepResult.socialScore).toBeGreaterThan(0);
    expect(lowRepResult.compositeScore).toBeGreaterThan(0);
  });

  it('uses zero social score for agents not in signals map', () => {
    const agent = createMockAgentProfile({ reputation: 5000 });
    const ranked = scorer.rankAgents([agent]);
    expect(ranked[0].socialScore).toBe(0);
    // Composite = 0.7 * 5000 + 0.3 * 0 = 3500
    expect(ranked[0].compositeScore).toBe(3500);
  });

  it('returns empty for empty input', () => {
    expect(scorer.rankAgents([])).toEqual([]);
  });
});

// ============================================================================
// Event Tracking
// ============================================================================

describe('ReputationScorer — event tracking', () => {
  let scorer: ReputationScorer;
  let program: ReturnType<typeof createMockProgram>;

  beforeEach(() => {
    ({ scorer, program } = createScorer());
  });

  afterEach(async () => {
    await scorer.dispose();
  });

  it('starts tracking and records events', () => {
    expect(scorer.isTracking).toBe(false);
    scorer.startTracking();
    expect(scorer.isTracking).toBe(true);
    expect(program.addEventListener).toHaveBeenCalledWith(
      'reputationChanged',
      expect.any(Function),
    );
  });

  it('throws when starting tracking twice', () => {
    scorer.startTracking();
    expect(() => scorer.startTracking()).toThrow(ReputationTrackingError);
  });

  it('records reputation change events in history', () => {
    scorer.startTracking();
    const agentId = Array.from(randomBytes32());

    program._emit('reputationChanged', {
      agentId,
      oldReputation: 5000,
      newReputation: 5100,
      reason: ReputationReason.COMPLETION,
      timestamp: { toNumber: () => 1700000000 },
    }, 100, 'sig1');

    expect(scorer.historySize).toBe(1);
    const history = scorer.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].oldReputation).toBe(5000);
    expect(history[0].newReputation).toBe(5100);
    expect(history[0].reason).toBe(ReputationReason.COMPLETION);
    expect(history[0].timestamp).toBe(1700000000);
  });

  it('filters history by agentId', () => {
    scorer.startTracking();
    const agent1 = new Uint8Array(32).fill(1);
    const agent2 = new Uint8Array(32).fill(2);

    program._emit('reputationChanged', {
      agentId: Array.from(agent1),
      oldReputation: 5000,
      newReputation: 5100,
      reason: 0,
      timestamp: { toNumber: () => 1700000000 },
    }, 100, 'sig1');

    program._emit('reputationChanged', {
      agentId: Array.from(agent2),
      oldReputation: 3000,
      newReputation: 2900,
      reason: 1,
      timestamp: { toNumber: () => 1700000001 },
    }, 101, 'sig2');

    expect(scorer.getHistory()).toHaveLength(2);
    expect(scorer.getHistory(agent1)).toHaveLength(1);
    expect(scorer.getHistory(agent1)[0].newReputation).toBe(5100);
    expect(scorer.getHistory(agent2)).toHaveLength(1);
    expect(scorer.getHistory(agent2)[0].newReputation).toBe(2900);
  });

  it('returns history newest-first', () => {
    scorer.startTracking();
    const agentId = Array.from(randomBytes32());

    for (let i = 0; i < 3; i++) {
      program._emit('reputationChanged', {
        agentId,
        oldReputation: 5000 + i * 100,
        newReputation: 5100 + i * 100,
        reason: 0,
        timestamp: { toNumber: () => 1700000000 + i },
      }, 100 + i, `sig${i}`);
    }

    const history = scorer.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].timestamp).toBe(1700000002);
    expect(history[2].timestamp).toBe(1700000000);
  });

  it('stopTracking unsubscribes', async () => {
    scorer.startTracking();
    expect(scorer.isTracking).toBe(true);
    await scorer.stopTracking();
    expect(scorer.isTracking).toBe(false);
    expect(program.removeEventListener).toHaveBeenCalled();
  });

  it('stopTracking is idempotent', async () => {
    await scorer.stopTracking(); // no-op when not tracking
    expect(scorer.isTracking).toBe(false);
  });

  it('dispose stops tracking', async () => {
    scorer.startTracking();
    await scorer.dispose();
    expect(scorer.isTracking).toBe(false);
  });

  it('returns empty history when no events received', () => {
    expect(scorer.getHistory()).toEqual([]);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('ReputationScorer — edge cases', () => {
  let scorer: ReputationScorer;

  beforeEach(() => {
    ({ scorer } = createScorer());
  });

  it('handles max reputation values', () => {
    const score = scorer.computeCompositeScore(REPUTATION_MAX, REPUTATION_MAX);
    expect(score).toBe(REPUTATION_MAX);
  });

  it('handles min reputation values', () => {
    const score = scorer.computeCompositeScore(REPUTATION_MIN, 0);
    expect(score).toBe(REPUTATION_MIN);
  });

  it('handles very large social scores', () => {
    const signals: SocialSignals = {
      postsAuthored: 100_000,
      upvotesReceived: 1_000_000,
      collaborationsCompleted: 50_000,
      messagesSent: 10_000_000,
      spamReports: 0,
    };
    const social = scorer.computeSocialScore(signals);
    expect(social).toBeGreaterThan(0);
    // Composite should still be capped at REPUTATION_MAX
    const composite = scorer.computeCompositeScore(REPUTATION_MAX, social);
    expect(composite).toBe(REPUTATION_MAX);
  });

  it('rankPosts with zero-upvote posts still produces valid scores', () => {
    const author = randomPubkey();
    const posts = [
      createMockFeedPost({ author, upvoteCount: 0 }),
    ];
    const reputationMap = new Map([[author.toBase58(), 5000]]);
    const ranked = scorer.rankPosts(posts, reputationMap);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(0);
  });
});
