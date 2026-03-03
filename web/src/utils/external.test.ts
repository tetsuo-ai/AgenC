import { describe, expect, it, vi, afterEach } from 'vitest';
import { openExternalUrl, sanitizeExplorerUrl } from './external';

describe('sanitizeExplorerUrl', () => {
  it('accepts https explorer.solana.com urls', () => {
    expect(
      sanitizeExplorerUrl('https://explorer.solana.com/address/abc?cluster=devnet'),
    ).toBe('https://explorer.solana.com/address/abc?cluster=devnet');
  });

  it('rejects non-https urls', () => {
    expect(
      sanitizeExplorerUrl('http://explorer.solana.com/address/abc?cluster=devnet'),
    ).toBe('');
  });

  it('rejects non-allowlisted hosts', () => {
    expect(
      sanitizeExplorerUrl('https://evil.example.com/address/abc?cluster=devnet'),
    ).toBe('');
  });
});

describe('openExternalUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens with noopener,noreferrer flags', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    openExternalUrl('https://explorer.solana.com/address/abc');
    expect(openSpy).toHaveBeenCalledWith(
      'https://explorer.solana.com/address/abc',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
