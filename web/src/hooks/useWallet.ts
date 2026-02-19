import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage } from '../types';

export interface WalletInfo {
  address: string;
  lamports: number;
  sol: number;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
}

interface UseWalletOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseWalletReturn {
  wallet: WalletInfo | null;
  loading: boolean;
  airdropping: boolean;
  lastError: string | null;
  refresh: () => void;
  airdrop: (amount?: number) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useWallet({ send, connected }: UseWalletOptions): UseWalletReturn {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [airdropping, setAirdropping] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const requestedRef = useRef(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setLastError(null);
    send({ type: 'wallet.info' });
  }, [send]);

  // Auto-fetch wallet info on connect
  useEffect(() => {
    if (connected && !requestedRef.current) {
      requestedRef.current = true;
      refresh();
    }
    if (!connected) {
      requestedRef.current = false;
    }
  }, [connected, refresh]);

  const airdrop = useCallback((amount = 1) => {
    setAirdropping(true);
    setLastError(null);
    send({ type: 'wallet.airdrop', payload: { amount } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'wallet.info') {
      setLoading(false);
      if (msg.error) {
        setLastError(msg.error);
      } else {
        const p = msg.payload as Record<string, unknown> | undefined;
        if (p) {
          setWallet({
            address: String(p.address ?? ''),
            lamports: Number(p.lamports ?? 0),
            sol: Number(p.sol ?? 0),
            network: String(p.network ?? 'unknown'),
            rpcUrl: String(p.rpcUrl ?? ''),
            explorerUrl: String(p.explorerUrl ?? ''),
          });
        }
      }
    }
    if (msg.type === 'wallet.airdrop') {
      setAirdropping(false);
      if (msg.error) {
        setLastError(msg.error);
      } else {
        const p = msg.payload as Record<string, unknown> | undefined;
        if (p) {
          // Update balance from airdrop response
          setWallet((prev) => prev ? {
            ...prev,
            sol: Number(p.newBalance ?? prev.sol),
            lamports: Number(p.newLamports ?? prev.lamports),
          } : prev);
        }
        setLastError(null);
      }
    }
  }, []);

  return { wallet, loading, airdropping, lastError, refresh, airdrop, handleMessage };
}
