import { useState, useEffect, useRef } from 'react';
import type { UseWalletReturn } from '../../hooks/useWallet';

interface PaymentViewProps {
  wallet: UseWalletReturn;
}

export function PaymentView({ wallet: w }: PaymentViewProps) {
  const { wallet, loading, airdropping, lastError, refresh, airdrop } = w;
  const isMainnet = wallet?.network === 'mainnet-beta';
  const isDevnet = wallet?.network === 'devnet';
  const [copied, setCopied] = useState(false);
  const [airdropSuccess, setAirdropSuccess] = useState(false);
  const prevSol = useRef(wallet?.sol ?? 0);

  useEffect(() => {
    if (wallet && wallet.sol !== prevSol.current) {
      if (wallet.sol > prevSol.current) {
        setAirdropSuccess(true);
        setTimeout(() => setAirdropSuccess(false), 1500);
      }
      prevSol.current = wallet.sol;
    }
  }, [wallet?.sol]);

  const truncateAddress = (addr: string) => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const copyAddress = () => {
    if (wallet?.address) {
      void navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  let idx = 0;
  const delay = () => `${(idx++) * 60}ms`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round">
              <rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" />
            </svg>
          </div>
          <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Payment</h2>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-accent hover:bg-tetsuo-100 transition-all duration-200 active:scale-90 disabled:opacity-50"
          title="Refresh"
        >
          <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6"><div className="max-w-2xl mx-auto space-y-6">
        {/* Balance card */}
        <div className="animate-list-item rounded-xl border border-tetsuo-200 p-5 relative overflow-hidden" style={{ animationDelay: delay() }}>
          {airdropSuccess && <div className="absolute inset-0 animate-shimmer pointer-events-none" />}
          <div className="flex items-center justify-between mb-1 relative">
            <div className="text-xs text-tetsuo-400 uppercase tracking-wider">SOL Balance</div>
          </div>
          {loading && !wallet ? (
            <div className="h-8 w-32 rounded bg-tetsuo-100 animate-pulse" />
          ) : wallet ? (
            <div className="relative">
              <div className={`font-bold text-tetsuo-800 transition-all duration-300 whitespace-nowrap ${airdropSuccess ? 'text-emerald-500' : ''} ${wallet.sol >= 1_000_000 ? 'text-base' : wallet.sol >= 1_000 ? 'text-xl' : 'text-2xl'}`}>
                {wallet.sol.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SOL
              </div>
              <div className="text-xs text-tetsuo-400 mt-1 capitalize">
                {wallet.network === 'mainnet-beta' ? 'Mainnet' : wallet.network}
              </div>
            </div>
          ) : lastError ? (
            <div className="text-sm text-red-500">{lastError}</div>
          ) : (
            <div className="text-2xl font-bold text-tetsuo-400">--</div>
          )}
        </div>

        {/* Wallet address */}
        {wallet && (
          <div className="animate-list-item" style={{ animationDelay: delay() }}>
            <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-2">Wallet Address</div>
            <button
              onClick={copyAddress}
              className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-tetsuo-50 border border-tetsuo-200 hover:bg-tetsuo-100 hover:border-tetsuo-300 transition-all duration-200 group active:scale-[0.98]"
              title="Click to copy"
            >
              <span className="text-sm text-tetsuo-600 font-mono truncate">{truncateAddress(wallet.address)}</span>
              {copied ? (
                <svg className="w-4 h-4 text-emerald-500 shrink-0 ml-2 animate-dot-pop" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
              ) : (
                <svg className="w-4 h-4 text-tetsuo-400 group-hover:text-tetsuo-600 shrink-0 ml-2 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        )}

        {/* Protocol Fees */}
        <div className="animate-list-item" style={{ animationDelay: delay() }}>
          <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-3">Protocol Fees</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-tetsuo-50 border border-tetsuo-200">
              <span className="text-sm text-tetsuo-600">Base fee</span>
              <span className="text-sm text-tetsuo-700">2.5%</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-tetsuo-50 border border-tetsuo-200">
              <span className="text-sm text-tetsuo-600">Fee tier</span>
              <span className="text-sm text-tetsuo-700">Base</span>
            </div>
          </div>
          <p className="text-xs text-tetsuo-400 mt-2">
            Complete more tasks to unlock fee discounts (Bronze 50+, Silver 200+, Gold 1000+).
          </p>
        </div>

        {/* Error */}
        {lastError && (
          <div className="text-xs text-red-500 px-1 animate-panel-enter">{lastError}</div>
        )}

        {/* Actions */}
        <div className="animate-list-item space-y-2" style={{ animationDelay: delay() }}>
          {!isMainnet && (
            <button
              onClick={() => airdrop(1)}
              disabled={airdropping || !wallet}
              className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-300 active:scale-[0.98] ${
                airdropping
                  ? 'bg-accent/70 text-white cursor-wait'
                  : 'bg-accent text-white hover:opacity-90 hover:shadow-lg hover:shadow-accent/20'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {airdropping ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                  </svg>
                  Requesting Airdrop...
                </span>
              ) : `Airdrop 1 SOL${isDevnet ? ' (Devnet)' : ''}`}
            </button>
          )}
          <button
            onClick={() => wallet?.explorerUrl && window.open(wallet.explorerUrl, '_blank')}
            disabled={!wallet}
            className="w-full py-2.5 rounded-lg border border-tetsuo-200 text-sm font-medium text-tetsuo-700 hover:bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            View on Explorer
          </button>
        </div>
      </div></div>
    </div>
  );
}
