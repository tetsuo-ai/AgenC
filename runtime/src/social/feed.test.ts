import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { PROGRAM_ID } from '@agenc/sdk';
import { generateAgentId } from '../utils/encoding.js';
import { RuntimeErrorCodes, AnchorErrorCodes } from '../types/errors.js';
import { FeedPostError, FeedUpvoteError, FeedQueryError } from './feed-errors.js';
import { deriveFeedPostPda, deriveFeedVotePda, AgentFeed } from './feed.js';
import {
  FEED_POST_AUTHOR_OFFSET,
  FEED_POST_TOPIC_OFFSET,
  type FeedPost,
} from './feed-types.js';

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

function anchorError(code: number) {
  return { code, message: `custom program error: 0x${code.toString(16)}` };
}

function createMockProgram(overrides: Record<string, unknown> = {}) {
  const rpcMock = vi.fn().mockResolvedValue('mock-signature');

  const methodBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    signers: vi.fn().mockReturnThis(),
    rpc: rpcMock,
  };

  return {
    programId: PROGRAM_ID,
    provider: {
      publicKey: randomPubkey(),
    },
    account: {
      feedPost: {
        fetchNullable: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue([]),
      },
    },
    methods: {
      postToFeed: vi.fn().mockReturnValue(methodBuilder),
      upvotePost: vi.fn().mockReturnValue(methodBuilder),
    },
    _methodBuilder: methodBuilder,
    _rpcMock: rpcMock,
    ...overrides,
  } as any;
}

function createTestFeed(overrides: Record<string, unknown> = {}) {
  const wallet = Keypair.generate();
  const agentId = generateAgentId(wallet.publicKey);
  const program = createMockProgram(overrides);

  const feed = new AgentFeed({
    program,
    agentId,
    wallet,
    ...overrides,
  });

  return { feed, program, wallet, agentId };
}

function createMockPostAccount(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    author: randomPubkey(),
    contentHash: Array.from(randomBytes32()),
    topic: Array.from(randomBytes32()),
    parentPost: null,
    nonce: Array.from(randomBytes32()),
    upvoteCount: 0,
    createdAt: { toNumber: () => 1700000000 },
    bump: 255,
    _reserved: [0, 0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

// ============================================================================
// PDA Derivation Tests
// ============================================================================

describe('deriveFeedPostPda', () => {
  it('returns deterministic PDA for same inputs', () => {
    const author = randomPubkey();
    const nonce = randomBytes32();
    const pda1 = deriveFeedPostPda(author, nonce, PROGRAM_ID);
    const pda2 = deriveFeedPostPda(author, nonce, PROGRAM_ID);
    expect(pda1.equals(pda2)).toBe(true);
  });

  it('returns different PDA for different authors', () => {
    const nonce = randomBytes32();
    const pda1 = deriveFeedPostPda(randomPubkey(), nonce, PROGRAM_ID);
    const pda2 = deriveFeedPostPda(randomPubkey(), nonce, PROGRAM_ID);
    expect(pda1.equals(pda2)).toBe(false);
  });

  it('returns different PDA for different nonces', () => {
    const author = randomPubkey();
    const pda1 = deriveFeedPostPda(author, randomBytes32(), PROGRAM_ID);
    const pda2 = deriveFeedPostPda(author, randomBytes32(), PROGRAM_ID);
    expect(pda1.equals(pda2)).toBe(false);
  });

  it('accepts number[] as nonce', () => {
    const author = randomPubkey();
    const nonce = Array.from(randomBytes32());
    const pda = deriveFeedPostPda(author, nonce, PROGRAM_ID);
    expect(pda).toBeInstanceOf(PublicKey);
  });
});

describe('deriveFeedVotePda', () => {
  it('returns deterministic PDA for same inputs', () => {
    const post = randomPubkey();
    const voter = randomPubkey();
    const pda1 = deriveFeedVotePda(post, voter, PROGRAM_ID);
    const pda2 = deriveFeedVotePda(post, voter, PROGRAM_ID);
    expect(pda1.equals(pda2)).toBe(true);
  });

  it('returns different PDA for different posts', () => {
    const voter = randomPubkey();
    const pda1 = deriveFeedVotePda(randomPubkey(), voter, PROGRAM_ID);
    const pda2 = deriveFeedVotePda(randomPubkey(), voter, PROGRAM_ID);
    expect(pda1.equals(pda2)).toBe(false);
  });

  it('returns different PDA for different voters', () => {
    const post = randomPubkey();
    const pda1 = deriveFeedVotePda(post, randomPubkey(), PROGRAM_ID);
    const pda2 = deriveFeedVotePda(post, randomPubkey(), PROGRAM_ID);
    expect(pda1.equals(pda2)).toBe(false);
  });
});

// ============================================================================
// AgentFeed.post() Tests
// ============================================================================

describe('AgentFeed.post()', () => {
  it('calls postToFeed with correct parameters', async () => {
    const { feed, program } = createTestFeed();
    const contentHash = randomBytes32();
    const nonce = randomBytes32();
    const topic = randomBytes32();

    const sig = await feed.post({ contentHash, nonce, topic });

    expect(sig).toBe('mock-signature');
    expect(program.methods.postToFeed).toHaveBeenCalledOnce();
    const args = program.methods.postToFeed.mock.calls[0];
    expect(new Uint8Array(args[0])).toEqual(contentHash);
    expect(new Uint8Array(args[1])).toEqual(nonce);
    expect(new Uint8Array(args[2])).toEqual(topic);
    expect(args[3]).toBeNull(); // no parent_post
  });

  it('passes parentPost when provided', async () => {
    const { feed, program } = createTestFeed();
    const parentPost = randomPubkey();

    await feed.post({
      contentHash: randomBytes32(),
      nonce: randomBytes32(),
      topic: randomBytes32(),
      parentPost,
    });

    const args = program.methods.postToFeed.mock.calls[0];
    expect(args[3]).toEqual(parentPost);
  });

  it('maps FeedInvalidContentHash to FeedPostError', async () => {
    const { feed, program } = createTestFeed();
    program._rpcMock.mockRejectedValueOnce(anchorError(AnchorErrorCodes.FeedInvalidContentHash));

    await expect(
      feed.post({
        contentHash: new Uint8Array(32), // all zeros
        nonce: randomBytes32(),
        topic: randomBytes32(),
      }),
    ).rejects.toThrow(FeedPostError);
  });

  it('maps FeedInvalidTopic to FeedPostError', async () => {
    const { feed, program } = createTestFeed();
    program._rpcMock.mockRejectedValueOnce(anchorError(AnchorErrorCodes.FeedInvalidTopic));

    await expect(
      feed.post({
        contentHash: randomBytes32(),
        nonce: randomBytes32(),
        topic: new Uint8Array(32),
      }),
    ).rejects.toThrow(FeedPostError);
  });

  it('maps AgentNotActive to FeedPostError', async () => {
    const { feed, program } = createTestFeed();
    program._rpcMock.mockRejectedValueOnce(anchorError(AnchorErrorCodes.AgentNotActive));

    await expect(
      feed.post({
        contentHash: randomBytes32(),
        nonce: randomBytes32(),
        topic: randomBytes32(),
      }),
    ).rejects.toThrow(FeedPostError);
  });

  it('accepts number[] inputs', async () => {
    const { feed } = createTestFeed();
    const sig = await feed.post({
      contentHash: Array.from(randomBytes32()),
      nonce: Array.from(randomBytes32()),
      topic: Array.from(randomBytes32()),
    });
    expect(sig).toBe('mock-signature');
  });
});

// ============================================================================
// AgentFeed.upvote() Tests
// ============================================================================

describe('AgentFeed.upvote()', () => {
  it('calls upvotePost with correct accounts', async () => {
    const { feed, program, wallet } = createTestFeed();
    const postPda = randomPubkey();

    const sig = await feed.upvote({ postPda });

    expect(sig).toBe('mock-signature');
    expect(program.methods.upvotePost).toHaveBeenCalledOnce();

    // Verify accountsPartial was called with expected keys
    const accountsArg = program._methodBuilder.accountsPartial.mock.calls[0][0];
    expect(accountsArg.post.equals(postPda)).toBe(true);
    expect(accountsArg.authority.equals(wallet.publicKey)).toBe(true);
    // vote PDA should be deterministic from postPda + agentPda
    expect(accountsArg.vote).toBeInstanceOf(PublicKey);
    expect(accountsArg.voter).toBeInstanceOf(PublicKey);
  });

  it('maps FeedSelfUpvote to FeedUpvoteError', async () => {
    const { feed, program } = createTestFeed();
    program._rpcMock.mockRejectedValueOnce(anchorError(AnchorErrorCodes.FeedSelfUpvote));

    await expect(
      feed.upvote({ postPda: randomPubkey() }),
    ).rejects.toThrow(FeedUpvoteError);
  });

  it('maps AgentNotActive to FeedUpvoteError', async () => {
    const { feed, program } = createTestFeed();
    program._rpcMock.mockRejectedValueOnce(anchorError(AnchorErrorCodes.AgentNotActive));

    await expect(
      feed.upvote({ postPda: randomPubkey() }),
    ).rejects.toThrow(FeedUpvoteError);
  });

  it('maps duplicate vote (already in use) to FeedUpvoteError', async () => {
    const { feed, program } = createTestFeed();
    program._rpcMock.mockRejectedValueOnce(new Error('Transaction simulation failed: account already in use'));

    const err = await feed.upvote({ postPda: randomPubkey() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedUpvoteError);
    expect((err as FeedUpvoteError).reason).toContain('Already upvoted');
  });
});

// ============================================================================
// AgentFeed.getPost() Tests
// ============================================================================

describe('AgentFeed.getPost()', () => {
  it('returns parsed post when found', async () => {
    const postPda = randomPubkey();
    const authorPda = randomPubkey();
    const mockAccount = createMockPostAccount({ author: authorPda });

    const { feed, program } = createTestFeed();
    program.account.feedPost.fetchNullable.mockResolvedValueOnce(mockAccount);

    const post = await feed.getPost(postPda);

    expect(post).not.toBeNull();
    expect(post!.pda.equals(postPda)).toBe(true);
    expect(post!.author.equals(authorPda)).toBe(true);
    expect(post!.contentHash).toBeInstanceOf(Uint8Array);
    expect(post!.contentHash.length).toBe(32);
    expect(post!.topic).toBeInstanceOf(Uint8Array);
    expect(post!.upvoteCount).toBe(0);
    expect(post!.createdAt).toBe(1700000000);
    expect(post!.parentPost).toBeNull();
  });

  it('returns null for non-existent post', async () => {
    const { feed } = createTestFeed();
    const post = await feed.getPost(randomPubkey());
    expect(post).toBeNull();
  });

  it('throws FeedQueryError on fetch failure', async () => {
    const { feed, program } = createTestFeed();
    program.account.feedPost.fetchNullable.mockRejectedValueOnce(new Error('Network error'));

    await expect(feed.getPost(randomPubkey())).rejects.toThrow(FeedQueryError);
  });

  it('parses parentPost when present', async () => {
    const parentPda = randomPubkey();
    const mockAccount = createMockPostAccount({ parentPost: parentPda });

    const { feed, program } = createTestFeed();
    program.account.feedPost.fetchNullable.mockResolvedValueOnce(mockAccount);

    const post = await feed.getPost(randomPubkey());
    expect(post!.parentPost).not.toBeNull();
    expect(post!.parentPost!.equals(parentPda)).toBe(true);
  });

  it('handles numeric createdAt (non-BN)', async () => {
    const mockAccount = createMockPostAccount({ createdAt: 1700000000 });

    const { feed, program } = createTestFeed();
    program.account.feedPost.fetchNullable.mockResolvedValueOnce(mockAccount);

    const post = await feed.getPost(randomPubkey());
    expect(post!.createdAt).toBe(1700000000);
  });
});

// ============================================================================
// AgentFeed.getFeed() Tests
// ============================================================================

describe('AgentFeed.getFeed()', () => {
  it('returns empty array when no posts exist', async () => {
    const { feed } = createTestFeed();
    const posts = await feed.getFeed();
    expect(posts).toEqual([]);
  });

  it('returns all posts sorted by createdAt desc by default', async () => {
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([
      { publicKey: randomPubkey(), account: createMockPostAccount({ createdAt: { toNumber: () => 100 } }) },
      { publicKey: randomPubkey(), account: createMockPostAccount({ createdAt: { toNumber: () => 300 } }) },
      { publicKey: randomPubkey(), account: createMockPostAccount({ createdAt: { toNumber: () => 200 } }) },
    ]);

    const posts = await feed.getFeed();
    expect(posts.length).toBe(3);
    expect(posts[0].createdAt).toBe(300);
    expect(posts[1].createdAt).toBe(200);
    expect(posts[2].createdAt).toBe(100);
  });

  it('sorts by upvoteCount when requested', async () => {
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([
      { publicKey: randomPubkey(), account: createMockPostAccount({ upvoteCount: 5 }) },
      { publicKey: randomPubkey(), account: createMockPostAccount({ upvoteCount: 10 }) },
      { publicKey: randomPubkey(), account: createMockPostAccount({ upvoteCount: 1 }) },
    ]);

    const posts = await feed.getFeed({ sortBy: 'upvoteCount', sortOrder: 'desc' });
    expect(posts[0].upvoteCount).toBe(10);
    expect(posts[1].upvoteCount).toBe(5);
    expect(posts[2].upvoteCount).toBe(1);
  });

  it('respects limit parameter', async () => {
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([
      { publicKey: randomPubkey(), account: createMockPostAccount() },
      { publicKey: randomPubkey(), account: createMockPostAccount() },
      { publicKey: randomPubkey(), account: createMockPostAccount() },
    ]);

    const posts = await feed.getFeed({ limit: 2 });
    expect(posts.length).toBe(2);
  });

  it('applies author memcmp filter', async () => {
    const authorPda = randomPubkey();
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([]);

    await feed.getFeed({ author: authorPda });

    const filters = program.account.feedPost.all.mock.calls[0][0];
    expect(filters).toHaveLength(1);
    expect(filters[0].memcmp.offset).toBe(FEED_POST_AUTHOR_OFFSET);
    expect(filters[0].memcmp.bytes).toBe(authorPda.toBase58());
  });

  it('applies topic memcmp filter with correct bytes', async () => {
    const topic = randomBytes32();
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([]);

    await feed.getFeed({ topic });

    const filters = program.account.feedPost.all.mock.calls[0][0];
    expect(filters).toHaveLength(1);
    expect(filters[0].memcmp.offset).toBe(FEED_POST_TOPIC_OFFSET);
    // Verify the bytes value is the bs58-encoded topic
    expect(typeof filters[0].memcmp.bytes).toBe('string');
    expect(filters[0].memcmp.bytes.length).toBeGreaterThan(0);
  });

  it('applies both author and topic filters', async () => {
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([]);

    await feed.getFeed({ author: randomPubkey(), topic: randomBytes32() });

    const filters = program.account.feedPost.all.mock.calls[0][0];
    expect(filters).toHaveLength(2);
  });

  it('throws FeedQueryError on failure', async () => {
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockRejectedValueOnce(new Error('RPC error'));

    await expect(feed.getFeed()).rejects.toThrow(FeedQueryError);
  });
});

// ============================================================================
// AgentFeed.getPostsByAuthor() / getPostsByTopic() Tests
// ============================================================================

describe('AgentFeed.getPostsByAuthor()', () => {
  it('passes author memcmp at correct offset', async () => {
    const authorPda = randomPubkey();
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([]);

    await feed.getPostsByAuthor(authorPda);

    const filters = program.account.feedPost.all.mock.calls[0][0];
    expect(filters[0].memcmp.offset).toBe(FEED_POST_AUTHOR_OFFSET);
    expect(filters[0].memcmp.bytes).toBe(authorPda.toBase58());
  });
});

describe('AgentFeed.getPostsByTopic()', () => {
  it('passes topic memcmp at correct offset', async () => {
    const topic = randomBytes32();
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([]);

    await feed.getPostsByTopic(topic);

    const filters = program.account.feedPost.all.mock.calls[0][0];
    expect(filters[0].memcmp.offset).toBe(FEED_POST_TOPIC_OFFSET);
  });

  it('accepts number[] topic', async () => {
    const topic = Array.from(randomBytes32());
    const { feed, program } = createTestFeed();
    program.account.feedPost.all.mockResolvedValueOnce([]);

    await feed.getPostsByTopic(topic);

    const filters = program.account.feedPost.all.mock.calls[0][0];
    expect(filters[0].memcmp.offset).toBe(FEED_POST_TOPIC_OFFSET);
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe('FeedPostError', () => {
  it('has correct code and name', () => {
    const err = new FeedPostError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.FEED_POST_ERROR);
    expect(err.name).toBe('FeedPostError');
    expect(err.reason).toBe('test reason');
    expect(err.message).toContain('test reason');
  });
});

describe('FeedUpvoteError', () => {
  it('has correct code and name', () => {
    const pda = randomPubkey().toBase58();
    const err = new FeedUpvoteError(pda, 'test reason');
    expect(err.code).toBe(RuntimeErrorCodes.FEED_UPVOTE_ERROR);
    expect(err.name).toBe('FeedUpvoteError');
    expect(err.postPda).toBe(pda);
    expect(err.reason).toBe('test reason');
  });
});

describe('FeedQueryError', () => {
  it('has correct code and name', () => {
    const err = new FeedQueryError('test reason');
    expect(err.code).toBe(RuntimeErrorCodes.FEED_QUERY_ERROR);
    expect(err.name).toBe('FeedQueryError');
    expect(err.reason).toBe('test reason');
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe('Feed constants', () => {
  it('FEED_POST_AUTHOR_OFFSET is 8 (after discriminator)', () => {
    expect(FEED_POST_AUTHOR_OFFSET).toBe(8);
  });

  it('FEED_POST_TOPIC_OFFSET is 72 (8 + 32 author + 32 content_hash)', () => {
    expect(FEED_POST_TOPIC_OFFSET).toBe(72);
  });
});
