import { describe, it, expect } from 'vitest';
import { PrivacyClient } from '../client';

describe('PrivacyClient input validation (#963)', () => {
  it('rejects invalid RPC URL', () => {
    expect(() => new PrivacyClient({ rpcUrl: 'not-a-url' })).toThrow('Invalid RPC URL');
  });

  it('rejects non-http RPC URL', () => {
    expect(() => new PrivacyClient({ rpcUrl: 'ftp://example.com' })).toThrow('http or https');
  });

  it('accepts valid HTTP RPC URL', () => {
    expect(() => new PrivacyClient({ rpcUrl: 'http://localhost:8899' })).not.toThrow();
  });

  it('accepts valid HTTPS RPC URL', () => {
    expect(() => new PrivacyClient({ rpcUrl: 'https://api.mainnet-beta.solana.com' })).not.toThrow();
  });

  it('accepts no RPC URL (defaults)', () => {
    expect(() => new PrivacyClient()).not.toThrow();
  });

  it('rejects invalid prover endpoint URL', () => {
    expect(() => new PrivacyClient({ proverEndpoint: 'not-a-url' }))
      .toThrow('Invalid prover endpoint');
  });

  it('rejects non-http prover endpoint URL', () => {
    expect(() => new PrivacyClient({ proverEndpoint: 'ws://localhost:8080' }))
      .toThrow('http or https');
  });

  it('accepts valid HTTPS prover endpoint URL', () => {
    expect(() => new PrivacyClient({ proverEndpoint: 'https://prover.example.com' }))
      .not.toThrow();
  });

  describe('completeTaskPrivate validation', () => {
    it('rejects when not initialized', async () => {
      const client = new PrivacyClient({ rpcUrl: 'http://localhost:8899' });
      await expect(
        client.completeTaskPrivate({
          taskId: 1,
          output: [1n, 2n, 3n, 4n],
          salt: 123n,
          recipientWallet: {} as any,
          escrowLamports: 1000,
        })
      ).rejects.toThrow('not initialized');
    });
  });
});
