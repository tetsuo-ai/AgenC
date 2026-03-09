import { useEffect, useRef, useState } from 'react';
import type { UseWalletReturn } from '../../hooks/useWallet';
import { openExternalUrl } from '../../utils/external';

interface PaymentViewProps {
  wallet: UseWalletReturn;
}

export function PaymentView({ wallet: walletState }: PaymentViewProps) {
  const { wallet, loading, airdropping, lastError, refresh, airdrop } = walletState;
  const isMainnet = wallet?.network === 'mainnet-beta';
  const isDevnet = wallet?.network === 'devnet';
  const [copied, setCopied] = useState(false);
  const [airdropSuccess, setAirdropSuccess] = useState(false);
  const previousSol = useRef(wallet?.sol ?? 0);

  useEffect(() => {
    if (wallet && wallet.sol !== previousSol.current) {
      if (wallet.sol > previousSol.current) {
        setAirdropSuccess(true);
        setTimeout(() => setAirdropSuccess(false), 1500);
      }
      previousSol.current = wallet.sol;
    }
  }, [wallet?.sol, wallet]);

  const truncateAddress = (address: string) => {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const copyAddress = () => {
    if (!wallet?.address) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-full flex-col bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <header className="border-b border-bbs-border bg-bbs-surface px-4 py-4 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
              <span className="text-bbs-purple">PAYMENT&gt;</span>
              <span>wallet settlement rail</span>
            </div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              Treasury and payout state
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              inspect balance, funding source, and protocol fee surface for the connected wallet
            </p>
          </div>

          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white disabled:opacity-50"
          >
            {loading ? '[refreshing]' : '[refresh]'}
          </button>
        </div>
      </header>

      {lastError ? (
        <div className="border-b border-bbs-red/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-red md:px-6">
          {lastError}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto grid max-w-4xl gap-4 lg:grid-cols-2">
          <section className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">balance</div>
            {loading && !wallet ? (
              <div className="mt-3 text-sm text-bbs-gray">[loading wallet]</div>
            ) : wallet ? (
              <>
                <div className={`mt-3 text-2xl font-bold uppercase tracking-[0.08em] ${airdropSuccess ? 'text-bbs-green' : 'text-bbs-white'}`}>
                  {wallet.sol.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SOL
                </div>
                <div className="mt-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
                  [{wallet.network === 'mainnet-beta' ? 'mainnet' : wallet.network}]
                </div>
              </>
            ) : (
              <div className="mt-3 text-sm text-bbs-gray">[wallet unavailable]</div>
            )}
          </section>

          {wallet ? (
            <section className="border border-bbs-border bg-bbs-dark px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">wallet address</div>
              <div className="mt-3 break-all text-sm text-bbs-lightgray">{wallet.address}</div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em]">
                <button
                  type="button"
                  onClick={copyAddress}
                  className="border border-bbs-border bg-bbs-black px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
                >
                  {copied ? '[copied]' : `[copy ${truncateAddress(wallet.address)}]`}
                </button>
                <button
                  type="button"
                  onClick={() => wallet.explorerUrl && openExternalUrl(wallet.explorerUrl)}
                  className="border border-bbs-cyan/40 bg-bbs-black px-3 py-2 text-bbs-cyan transition-colors hover:text-bbs-white"
                >
                  [view explorer]
                </button>
              </div>
            </section>
          ) : null}

          <section className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">protocol fees</div>
            <div className="mt-4 grid gap-2 text-sm">
              <FeeRow label="base fee" value="2.5%" />
              <FeeRow label="fee tier" value="base" />
            </div>
            <p className="mt-3 text-xs text-bbs-gray">
              complete more tasks to unlock fee discounts: bronze 50+, silver 200+, gold 1000+
            </p>
          </section>

          <section className="border border-bbs-border bg-bbs-dark px-4 py-4 lg:col-span-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">actions</div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em]">
              {!isMainnet ? (
                <button
                  type="button"
                  onClick={() => airdrop(1)}
                  disabled={airdropping || !wallet}
                  className="border border-bbs-green/40 bg-bbs-black px-3 py-2 text-bbs-green transition-colors hover:text-bbs-white disabled:opacity-50"
                >
                  {airdropping ? '[requesting airdrop...]' : `airdrop 1 sol${isDevnet ? ' (devnet)' : ''}`}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function FeeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border border-bbs-border bg-bbs-black/40 px-3 py-3">
      <span className="text-bbs-gray">{label}</span>
      <span className="text-bbs-lightgray uppercase">{value}</span>
    </div>
  );
}
