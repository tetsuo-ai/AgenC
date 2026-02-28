import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WSMessage } from '../types';
import { useWallet } from './useWallet';

describe('useWallet', () => {
  it('fetches wallet info automatically when connected', () => {
    const send = vi.fn();
    renderHook(() => useWallet({ send, connected: true }));

    expect(send).toHaveBeenCalledWith({ type: 'wallet.info' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('handles wallet.info success and loading states', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useWallet({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: 'wallet.info',
        payload: {
          address: 'Wallet123',
          lamports: 12_345,
          sol: 1.23,
          network: 'devnet',
          rpcUrl: 'https://api.devnet.solana.com',
          explorerUrl: 'https://explorer.solana.com',
        },
      } as WSMessage,
      );
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.wallet?.address).toBe('Wallet123');
    expect(result.current.wallet?.sol).toBe(1.23);
  });

  it('records wallet.info errors', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useWallet({ send, connected: true }));

    act(() => {
      result.current.handleMessage({ type: 'wallet.info', error: 'denied' } as WSMessage);
    });

    expect(result.current.lastError).toBe('denied');
    expect(result.current.loading).toBe(false);
  });

  it('sends and handles airdrop updates', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useWallet({ send, connected: true }));

    act(() => {
      result.current.airdrop(2);
    });

    expect(send).toHaveBeenCalledWith({ type: 'wallet.airdrop', payload: { amount: 2 } });

    act(() => {
      result.current.handleMessage({
        type: 'wallet.airdrop',
        payload: { newBalance: 12.34, newLamports: 12_340_000_000 },
      } as WSMessage);
    });

    expect(result.current.airdropping).toBe(false);
    expect(result.current.wallet).toBeNull();
  });

  it('resets request on connect false -> true', () => {
    const send = vi.fn();
    const { rerender } = renderHook(
      ({ connected }) => useWallet({ send, connected }),
      { initialProps: { connected: false } },
    );

    expect(send).not.toHaveBeenCalled();

    rerender({ connected: true });
    rerender({ connected: false });
    rerender({ connected: true });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({ type: 'wallet.info' });
  });
});
