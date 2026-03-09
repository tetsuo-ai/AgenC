interface BBSStatusBarProps {
  activeNetwork?: string | null;
  targetNetwork?: string | null;
}

type SolanaNetwork = 'mainnet' | 'devnet' | 'testnet' | 'custom' | 'unknown';

export function BBSStatusBar({ activeNetwork, targetNetwork }: BBSStatusBarProps) {
  const active = normalizeSolanaNetwork(activeNetwork);
  const target = normalizeSolanaNetwork(targetNetwork);
  const displayNetwork = active !== 'unknown' ? active : target;
  const pendingNetwork =
    active !== 'unknown' && target !== 'unknown' && active !== target ? target : null;
  const statusText = [
    'AgenC v0.1.0',
    `Solana ${formatSolanaNetwork(displayNetwork)}`,
    pendingNetwork ? `${formatSolanaNetwork(pendingNetwork)} pending restart` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return (
    <div className="shrink-0 bg-bbs-purple-dim/30 border-t border-bbs-purple-dim px-4 py-1.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-bbs-white">
          {statusText}
        </span>
        <span className="text-bbs-pink">
          BBS Terminal v1.0
        </span>
      </div>
    </div>
  );
}

function normalizeSolanaNetwork(value?: string | null): SolanaNetwork {
  if (!value) return 'unknown';

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') return 'unknown';
  if (normalized.includes('mainnet')) return 'mainnet';
  if (normalized.includes('devnet')) return 'devnet';
  if (normalized.includes('testnet')) return 'testnet';
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return 'custom';

  return 'custom';
}

function formatSolanaNetwork(network: SolanaNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'Mainnet';
    case 'devnet':
      return 'Devnet';
    case 'testnet':
      return 'Testnet';
    case 'custom':
      return 'Custom RPC';
    default:
      return 'Unknown';
  }
}
