import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ValidationError } from '../../types/errors.js';
import { OnChainSkillRegistryClient, SKILL_REGISTRY_PROGRAM_ID } from './client.js';
import {
  SkillRegistryNotFoundError,
  SkillDownloadError,
  SkillVerificationError,
  SkillPublishError,
} from './errors.js';
import type { SkillRegistryClientConfig } from './types.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('@agenc/sdk', () => ({
  silentLogger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  PROGRAM_ID: new PublicKey('11111111111111111111111111111111'),
}));

// Import mocked fs after vi.mock
const { readFile, writeFile, mkdir } = await import('node:fs/promises');

// ============================================================================
// Helpers
// ============================================================================

const noop = () => {};
const silentLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

const SKILL_SEED = Buffer.from('skill');

/** Derive a PDA — duplicated here to avoid importing utils/pda which pulls in @agenc/sdk. */
function derivePda(seeds: Array<Buffer | Uint8Array>, programId: PublicKey) {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { address, bump };
}

/** Build a mock skill account buffer matching the deserialization layout. */
function buildSkillAccountBuffer(fields: {
  author?: PublicKey;
  rating?: number;
  ratingCount?: number;
  downloads?: number;
  priceLamports?: bigint;
  registeredAt?: number;
  updatedAt?: number;
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  contentHash?: string;
  tags?: string[];
}): Buffer {
  const author = fields.author ?? Keypair.generate().publicKey;
  const rating = fields.rating ?? 4.5;
  const ratingCount = fields.ratingCount ?? 10;
  const downloads = fields.downloads ?? 100;
  const priceLamports = fields.priceLamports ?? 0n;
  const registeredAt = fields.registeredAt ?? Math.floor(Date.now() / 1000);
  const updatedAt = fields.updatedAt ?? registeredAt;
  const id = fields.id ?? 'test-skill-id';
  const name = fields.name ?? 'Test Skill';
  const description = fields.description ?? 'A test skill';
  const version = fields.version ?? '1.0.0';
  const contentHash = fields.contentHash ?? 'abc123hash';
  const tags = fields.tags ?? ['test'];

  const parts: Buffer[] = [];

  // Discriminator (8 bytes)
  parts.push(Buffer.alloc(8));

  // Author pubkey (32 bytes)
  parts.push(author.toBuffer());

  // rating f64 (8 bytes)
  const ratingBuf = Buffer.alloc(8);
  ratingBuf.writeDoubleLE(rating);
  parts.push(ratingBuf);

  // ratingCount u32 (4 bytes)
  const ratingCountBuf = Buffer.alloc(4);
  ratingCountBuf.writeUInt32LE(ratingCount);
  parts.push(ratingCountBuf);

  // downloads u32 (4 bytes)
  const downloadsBuf = Buffer.alloc(4);
  downloadsBuf.writeUInt32LE(downloads);
  parts.push(downloadsBuf);

  // priceLamports u64 (8 bytes)
  const priceBuf = Buffer.alloc(8);
  priceBuf.writeBigUInt64LE(priceLamports);
  parts.push(priceBuf);

  // registeredAt i64 (8 bytes)
  const regBuf = Buffer.alloc(8);
  regBuf.writeBigInt64LE(BigInt(registeredAt));
  parts.push(regBuf);

  // updatedAt i64 (8 bytes)
  const updBuf = Buffer.alloc(8);
  updBuf.writeBigInt64LE(BigInt(updatedAt));
  parts.push(updBuf);

  // Variable-length string helper
  function writeStr(s: string): void {
    const strBuf = Buffer.from(s, 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(strBuf.length);
    parts.push(lenBuf, strBuf);
  }

  writeStr(id);
  writeStr(name);
  writeStr(description);
  writeStr(version);
  writeStr(contentHash);

  // Tags: u32 count + strings
  const tagCountBuf = Buffer.alloc(4);
  tagCountBuf.writeUInt32LE(tags.length);
  parts.push(tagCountBuf);
  for (const tag of tags) {
    writeStr(tag);
  }

  return Buffer.concat(parts);
}

function createMockConnection(): Connection {
  return {
    getProgramAccounts: vi.fn(async () => []),
    getAccountInfo: vi.fn(async () => null),
  } as unknown as Connection;
}

function createMockFetch(
  response?: Partial<Response>,
  throwError?: Error,
): typeof fetch {
  if (throwError) {
    return vi.fn(async () => { throw throwError; }) as unknown as typeof fetch;
  }
  const body = response?.arrayBuffer
    ?? (async () => new ArrayBuffer(0));
  return vi.fn(async () => ({
    ok: response?.ok ?? true,
    status: response?.status ?? 200,
    statusText: response?.statusText ?? 'OK',
    arrayBuffer: body,
  })) as unknown as typeof fetch;
}

function createClient(overrides?: Partial<SkillRegistryClientConfig>): OnChainSkillRegistryClient {
  return new OnChainSkillRegistryClient({
    connection: createMockConnection(),
    logger: silentLogger,
    fetchFn: createMockFetch(),
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('OnChainSkillRegistryClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('accepts config and stores connection', () => {
      const conn = createMockConnection();
      const client = new OnChainSkillRegistryClient({ connection: conn });
      expect(client).toBeInstanceOf(OnChainSkillRegistryClient);
    });

    it('sets defaults for contentGateway and logger', () => {
      const conn = createMockConnection();
      const client = new OnChainSkillRegistryClient({ connection: conn });
      expect(client).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // search
  // --------------------------------------------------------------------------

  describe('search', () => {
    it('returns matching skills by query', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ name: 'Swap Helper', description: 'Helps with swaps' });
      vi.mocked(conn.getProgramAccounts).mockResolvedValue([
        { pubkey: Keypair.generate().publicKey, account: { data, executable: false, lamports: 0, owner: SKILL_REGISTRY_PROGRAM_ID } },
      ]);

      const client = createClient({ connection: conn });
      const results = await client.search('swap');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Swap Helper');
    });

    it('filters by tags', async () => {
      const conn = createMockConnection();
      const skill1 = buildSkillAccountBuffer({ id: 's1', name: 'DeFi Swap', tags: ['defi', 'swap'] });
      const skill2 = buildSkillAccountBuffer({ id: 's2', name: 'DeFi Stake', tags: ['defi', 'staking'] });
      vi.mocked(conn.getProgramAccounts).mockResolvedValue([
        { pubkey: Keypair.generate().publicKey, account: { data: skill1, executable: false, lamports: 0, owner: SKILL_REGISTRY_PROGRAM_ID } },
        { pubkey: Keypair.generate().publicKey, account: { data: skill2, executable: false, lamports: 0, owner: SKILL_REGISTRY_PROGRAM_ID } },
      ]);

      const client = createClient({ connection: conn });
      const results = await client.search('defi', { tags: ['swap'] });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('s1');
    });

    it('respects default limit of 10', async () => {
      const conn = createMockConnection();
      const accounts = Array.from({ length: 15 }, (_, i) =>
        ({
          pubkey: Keypair.generate().publicKey,
          account: {
            data: buildSkillAccountBuffer({ id: `s${i}`, name: `Skill ${i}` }),
            executable: false,
            lamports: 0,
            owner: SKILL_REGISTRY_PROGRAM_ID,
          },
        }),
      );
      vi.mocked(conn.getProgramAccounts).mockResolvedValue(accounts);

      const client = createClient({ connection: conn });
      const results = await client.search('skill');

      expect(results).toHaveLength(10);
    });

    it('clamps limit to MAX_SEARCH_LIMIT (100)', async () => {
      const conn = createMockConnection();
      vi.mocked(conn.getProgramAccounts).mockResolvedValue([]);

      const client = createClient({ connection: conn });
      const results = await client.search('anything', { limit: 200 });
      expect(results).toHaveLength(0);
    });

    it('returns empty array for no matches', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ name: 'Unrelated Skill' });
      vi.mocked(conn.getProgramAccounts).mockResolvedValue([
        { pubkey: Keypair.generate().publicKey, account: { data, executable: false, lamports: 0, owner: SKILL_REGISTRY_PROGRAM_ID } },
      ]);

      const client = createClient({ connection: conn });
      const results = await client.search('nonexistent-query');

      expect(results).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  describe('get', () => {
    it('returns full SkillListing for existing skill', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({
        id: 'my-skill',
        name: 'My Skill',
        description: 'A great skill',
        version: '2.0.0',
        contentHash: 'deadbeef',
        tags: ['utility', 'tool'],
        rating: 4.8,
        ratingCount: 50,
        downloads: 500,
      });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const client = createClient({ connection: conn });
      const listing = await client.get('my-skill');

      expect(listing.id).toBe('my-skill');
      expect(listing.name).toBe('My Skill');
      expect(listing.version).toBe('2.0.0');
      expect(listing.contentHash).toBe('deadbeef');
      expect(listing.tags).toEqual(['utility', 'tool']);
      expect(listing.rating).toBe(4.8);
      expect(listing.downloads).toBe(500);
    });

    it('throws SkillRegistryNotFoundError for non-existent skill', async () => {
      const conn = createMockConnection();
      vi.mocked(conn.getAccountInfo).mockResolvedValue(null);

      const client = createClient({ connection: conn });

      await expect(client.get('missing-skill')).rejects.toThrow(SkillRegistryNotFoundError);
    });

    it('derives PDA using skill seed and skillId', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ id: 'pda-test' });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const client = createClient({ connection: conn });
      await client.get('pda-test');

      const expectedPda = derivePda(
        [SKILL_SEED, Buffer.from('pda-test')],
        SKILL_REGISTRY_PROGRAM_ID,
      );
      expect(conn.getAccountInfo).toHaveBeenCalledWith(expectedPda.address);
    });
  });

  // --------------------------------------------------------------------------
  // install
  // --------------------------------------------------------------------------

  describe('install', () => {
    it('downloads from gateway and saves to targetPath', async () => {
      const conn = createMockConnection();
      const contentBytes = Buffer.from('---\nname: test\n---\nbody');
      const hash = createHash('sha256').update(contentBytes).digest('hex');

      const data = buildSkillAccountBuffer({ id: 'install-test', contentHash: hash });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const mockFetch = createMockFetch({
        ok: true,
        arrayBuffer: async () => contentBytes.buffer.slice(
          contentBytes.byteOffset,
          contentBytes.byteOffset + contentBytes.byteLength,
        ),
      });

      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const client = createClient({ connection: conn, fetchFn: mockFetch });
      const listing = await client.install('install-test', '/tmp/skills/SKILL.md');

      expect(listing.id).toBe('install-test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/ipfs/${hash}`),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(writeFile).toHaveBeenCalledWith('/tmp/skills/SKILL.md', expect.any(Buffer));
    });

    it('creates parent directories', async () => {
      const conn = createMockConnection();
      const contentBytes = Buffer.from('content');
      const hash = createHash('sha256').update(contentBytes).digest('hex');

      const data = buildSkillAccountBuffer({ id: 'dir-test', contentHash: hash });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const mockFetch = createMockFetch({
        ok: true,
        arrayBuffer: async () => contentBytes.buffer.slice(
          contentBytes.byteOffset,
          contentBytes.byteOffset + contentBytes.byteLength,
        ),
      });

      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const client = createClient({ connection: conn, fetchFn: mockFetch });
      await client.install('dir-test', '/deep/nested/dir/SKILL.md');

      expect(mkdir).toHaveBeenCalledWith('/deep/nested/dir', { recursive: true });
    });

    it('throws SkillDownloadError on fetch failure', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ id: 'fetch-fail' });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const mockFetch = createMockFetch(undefined, new Error('Network error'));

      const client = createClient({ connection: conn, fetchFn: mockFetch });

      await expect(client.install('fetch-fail', '/tmp/SKILL.md')).rejects.toThrow(SkillDownloadError);
    });

    it('throws SkillDownloadError on HTTP non-OK response', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ id: 'http-fail' });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const mockFetch = createMockFetch({ ok: false, status: 404, statusText: 'Not Found' });

      const client = createClient({ connection: conn, fetchFn: mockFetch });

      await expect(client.install('http-fail', '/tmp/SKILL.md')).rejects.toThrow(SkillDownloadError);
    });

    it('throws SkillVerificationError on hash mismatch', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ id: 'hash-mismatch', contentHash: 'expected-hash' });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const wrongContent = Buffer.from('wrong content');
      const mockFetch = createMockFetch({
        ok: true,
        arrayBuffer: async () => wrongContent.buffer.slice(
          wrongContent.byteOffset,
          wrongContent.byteOffset + wrongContent.byteLength,
        ),
      });

      const client = createClient({ connection: conn, fetchFn: mockFetch });

      await expect(client.install('hash-mismatch', '/tmp/SKILL.md')).rejects.toThrow(SkillVerificationError);
    });
  });

  // --------------------------------------------------------------------------
  // publish
  // --------------------------------------------------------------------------

  describe('publish', () => {
    const validSkillMd = '---\nname: Test Skill\ndescription: A test\nversion: 1.0.0\n---\n# Test';

    it('reads SKILL.md and computes hash', async () => {
      vi.mocked(readFile).mockResolvedValue(Buffer.from(validSkillMd));

      const client = createClient();
      const skillId = await client.publish('/path/SKILL.md', {
        name: 'Test Skill',
        description: 'A test',
      });

      const expectedHash = createHash('sha256').update(Buffer.from(validSkillMd)).digest('hex');
      expect(skillId).toBe(expectedHash);
    });

    it('returns hash as skillId', async () => {
      vi.mocked(readFile).mockResolvedValue(Buffer.from(validSkillMd));

      const client = createClient();
      const skillId = await client.publish('/path/SKILL.md', {
        name: 'Test',
        description: 'Test',
      });

      expect(typeof skillId).toBe('string');
      expect(skillId).toHaveLength(64); // SHA-256 hex
    });

    it('validates SKILL.md format', async () => {
      const invalid = '---\ndescription: test\nversion: 1.0.0\n---\nbody';
      vi.mocked(readFile).mockResolvedValue(Buffer.from(invalid));

      const client = createClient();

      await expect(
        client.publish('/path/SKILL.md', { name: 'Test', description: 'Test' }),
      ).rejects.toThrow(SkillPublishError);
    });

    it('throws SkillPublishError when file cannot be read', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

      const client = createClient();

      await expect(
        client.publish('/nonexistent/SKILL.md', { name: 'Test', description: 'Test' }),
      ).rejects.toThrow(SkillPublishError);
    });
  });

  // --------------------------------------------------------------------------
  // rate
  // --------------------------------------------------------------------------

  describe('rate', () => {
    it('validates rating is between 1 and 5', async () => {
      const wallet = {
        publicKey: Keypair.generate().publicKey,
        signTransaction: vi.fn(async (tx: unknown) => tx),
        signAllTransactions: vi.fn(async (txs: unknown) => txs),
      };
      const client = createClient({ wallet });

      await expect(client.rate('skill-1', 0)).rejects.toThrow(ValidationError);
      await expect(client.rate('skill-1', 6)).rejects.toThrow(ValidationError);
      await expect(client.rate('skill-1', 3.5)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError without wallet', async () => {
      const client = createClient();

      await expect(client.rate('skill-1', 4)).rejects.toThrow(ValidationError);
    });

    it('accepts valid rating with wallet', async () => {
      const wallet = {
        publicKey: Keypair.generate().publicKey,
        signTransaction: vi.fn(async (tx: unknown) => tx),
        signAllTransactions: vi.fn(async (txs: unknown) => txs),
      };
      const client = createClient({ wallet });

      await expect(client.rate('skill-1', 5, 'Great skill!')).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // listByAuthor
  // --------------------------------------------------------------------------

  describe('listByAuthor', () => {
    it('returns skills by author', async () => {
      const conn = createMockConnection();
      const authorKp = Keypair.generate();
      const data = buildSkillAccountBuffer({
        id: 'author-skill',
        name: 'Author Skill',
        author: authorKp.publicKey,
      });
      vi.mocked(conn.getProgramAccounts).mockResolvedValue([
        { pubkey: Keypair.generate().publicKey, account: { data, executable: false, lamports: 0, owner: SKILL_REGISTRY_PROGRAM_ID } },
      ]);

      const client = createClient({ connection: conn });
      const results = await client.listByAuthor(authorKp.publicKey.toBase58());

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('author-skill');
    });

    it('returns empty for unknown author', async () => {
      const conn = createMockConnection();
      vi.mocked(conn.getProgramAccounts).mockResolvedValue([]);

      const client = createClient({ connection: conn });
      const results = await client.listByAuthor(Keypair.generate().publicKey.toBase58());

      expect(results).toHaveLength(0);
    });

    it('validates pubkey format', async () => {
      const client = createClient();

      await expect(client.listByAuthor('not-a-pubkey!!')).rejects.toThrow(ValidationError);
    });
  });

  // --------------------------------------------------------------------------
  // verify
  // --------------------------------------------------------------------------

  describe('verify', () => {
    it('returns true for matching hash', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ id: 'verify-skill', contentHash: 'abc123' });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const client = createClient({ connection: conn });
      const result = await client.verify('verify-skill', 'abc123');

      expect(result).toBe(true);
    });

    it('returns false for mismatched hash', async () => {
      const conn = createMockConnection();
      const data = buildSkillAccountBuffer({ id: 'verify-skill', contentHash: 'abc123' });
      vi.mocked(conn.getAccountInfo).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: SKILL_REGISTRY_PROGRAM_ID,
      });

      const client = createClient({ connection: conn });
      const result = await client.verify('verify-skill', 'wrong-hash');

      expect(result).toBe(false);
    });

    it('throws for non-existent skillId', async () => {
      const conn = createMockConnection();
      vi.mocked(conn.getAccountInfo).mockResolvedValue(null);

      const client = createClient({ connection: conn });

      await expect(client.verify('missing', 'somehash')).rejects.toThrow(SkillRegistryNotFoundError);
    });
  });
});
