/**
 * PumpTracks client unit tests.
 *
 * Covers: API requests, error handling, timeout behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PumpTracksClient, PumpTracksApiError } from './pumptracks-client.js';

// ─── Mock helpers ────────────────────────────────────────

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createClient(overrides?: { apiBaseUrl?: string; timeoutMs?: number }) {
  return new PumpTracksClient({
    apiBaseUrl: overrides?.apiBaseUrl ?? 'https://pumptracks.fun/api/v1',
    apiKey: 'pt_live_test_key_12345',
    timeoutMs: overrides?.timeoutMs ?? 30_000,
    logger: createMockLogger() as any,
  });
}

// ─── Tests ───────────────────────────────────────────────

describe('PumpTracksClient', () => {
  let client: PumpTracksClient;

  beforeEach(() => {
    client = createClient();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── listTracks ──

  describe('listTracks', () => {
    it('returns tracks from API', async () => {
      const mockTracks = [
        { mint: 'abc', title: 'Song A', artist: 'Artist A' },
        { mint: 'def', title: 'Song B', artist: 'Artist B' },
      ];

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: mockTracks } }),
      });

      const result = await client.listTracks({ genre: 'Electronic', limit: 10 });
      expect(result).toEqual(mockTracks);
      expect(result).toHaveLength(2);
    });

    it('passes query parameters correctly', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: [] } }),
      });

      await client.listTracks({ genre: 'Hip-Hop', limit: 5, offset: 10, sort: 'playCount', order: 'desc' });

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('genre=Hip-Hop');
      expect(calledUrl).toContain('limit=5');
      expect(calledUrl).toContain('offset=10');
      expect(calledUrl).toContain('sort=playCount');
      expect(calledUrl).toContain('order=desc');
    });

    it('throws PumpTracksApiError on HTTP error', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(client.listTracks()).rejects.toThrow(PumpTracksApiError);
    });

    it('throws on API error response', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: 'Something went wrong' }),
      });

      await expect(client.listTracks()).rejects.toThrow('Something went wrong');
    });
  });

  // ── getTrack ──

  describe('getTrack', () => {
    it('returns track by mint', async () => {
      const mockTrack = { mint: 'abc123', title: 'Test', artist: 'Artist' };

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: mockTrack }),
      });

      const result = await client.getTrack('abc123');
      expect(result.mint).toBe('abc123');
    });

    it('includes mint in URL', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { mint: 'xyz' } }),
      });

      await client.getTrack('xyz789');

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('/tracks/xyz789');
    });

    it('throws on 404', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      await expect(client.getTrack('nonexistent')).rejects.toThrow(PumpTracksApiError);
    });
  });

  // ── searchTracks ──

  describe('searchTracks', () => {
    it('sends search query', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: [] } }),
      });

      await client.searchTracks({ q: 'lofi beats', limit: 5 });

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0];
      expect(calledUrl).toContain('q=lofi+beats');
      expect(calledUrl).toContain('limit=5');
    });
  });

  // ── getArtist ──

  describe('getArtist', () => {
    it('returns artist profile', async () => {
      const mockArtist = { wallet: 'abc', trackCount: 3, totalPlays: 100, tracks: [] };

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: mockArtist }),
      });

      const result = await client.getArtist('abc');
      expect(result.trackCount).toBe(3);
    });
  });

  // ── Authentication ──

  describe('authentication', () => {
    it('sends API key in X-API-Key header', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { tracks: [] } }),
      });

      await client.listTracks();

      const calledInit = (globalThis.fetch as any).mock.calls[0][1];
      expect(calledInit.headers['X-API-Key']).toBe('pt_live_test_key_12345');
    });
  });

  // ── Timeout ──

  describe('timeout', () => {
    it('aborts request after timeout', async () => {
      const shortClient = createClient({ timeoutMs: 1 });

      (globalThis.fetch as any).mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );

      await expect(shortClient.listTracks()).rejects.toThrow('timed out');
    });
  });

  // ── prepareMint ──

  describe('prepareMint', () => {
    it('sends FormData and returns prepare result', async () => {
      const mockResult = {
        transactions: ['base64tx1'],
        mint: 'mintAddress',
        trackInfo: {
          title: 'Test',
          artist: 'Artist',
          genre: 'Electronic',
          symbol: 'TEST',
          metadataUri: 'ipfs://Qm...',
          artUri: 'https://storage.googleapis.com/...',
          trackUri: 'https://storage.googleapis.com/...',
          wallet: 'walletAddress',
        },
      };

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: mockResult }),
      });

      const formData = new FormData();
      formData.append('title', 'Test');

      const result = await client.prepareMint(formData);
      expect(result.transactions).toHaveLength(1);
      expect(result.mint).toBe('mintAddress');
    });

    it('throws on prepare failure', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Missing required fields'),
      });

      await expect(client.prepareMint(new FormData())).rejects.toThrow(PumpTracksApiError);
    });
  });

  // ── registerTrack ──

  describe('registerTrack', () => {
    it('sends mint + txIds + trackInfo and returns result', async () => {
      const mockResult = {
        mint: 'mintAddress',
        txIds: ['txSig1'],
        playUrl: 'https://pumptracks.fun/play/mintAddress',
      };

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: mockResult }),
      });

      const result = await client.registerTrack(
        'mintAddress',
        ['txSig1'],
        {
          title: 'Test',
          artist: 'Artist',
          genre: 'Electronic',
          symbol: 'TEST',
          metadataUri: 'ipfs://Qm...',
          artUri: 'https://storage.googleapis.com/...',
          trackUri: 'https://storage.googleapis.com/...',
          wallet: 'walletAddress',
        },
      );

      expect(result.playUrl).toContain('pumptracks.fun');
      expect(result.txIds).toHaveLength(1);
    });

    it('sends JSON body to /tracks/register with correct content type', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { mint: 'x', txIds: ['t'], playUrl: 'u' },
        }),
      });

      await client.registerTrack('mint', ['txSig1'], {
        title: 'T', artist: 'A', genre: 'G', symbol: 'S',
        metadataUri: 'ipfs://x', artUri: 'https://a', trackUri: 'https://t', wallet: 'w',
      });

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0];
      const calledInit = (globalThis.fetch as any).mock.calls[0][1];
      expect(calledUrl).toContain('/tracks/register');
      expect(calledInit.headers['Content-Type']).toBe('application/json');
      expect(calledInit.method).toBe('POST');
    });

    it('does NOT send signed transactions in the request body', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { mint: 'x', txIds: ['t'], playUrl: 'u' },
        }),
      });

      await client.registerTrack('mint', ['txSig1'], {
        title: 'T', artist: 'A', genre: 'G', symbol: 'S',
        metadataUri: 'ipfs://x', artUri: 'https://a', trackUri: 'https://t', wallet: 'w',
      });

      const calledInit = (globalThis.fetch as any).mock.calls[0][1];
      const body = JSON.parse(calledInit.body);
      // Body should contain mint, txIds, trackInfo — but NOT signedTransactions
      expect(body.mint).toBe('mint');
      expect(body.txIds).toEqual(['txSig1']);
      expect(body.trackInfo).toBeDefined();
      expect(body.signedTransactions).toBeUndefined();
      expect(body.transactions).toBeUndefined();
    });

    it('throws on register failure', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Mint not found on-chain'),
      });

      await expect(
        client.registerTrack('badMint', ['txSig'], {
          title: 'T', artist: 'A', genre: 'G', symbol: 'S',
          metadataUri: 'ipfs://x', artUri: 'https://a', trackUri: 'https://t', wallet: 'w',
        }),
      ).rejects.toThrow(PumpTracksApiError);
    });
  });
});
