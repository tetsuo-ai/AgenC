import { TaskState } from '../App'

interface Props {
  taskState: TaskState
  onReset: () => void
}

export default function CompletionSummary({ taskState, onReset }: Props) {
  return (
    <div className="bg-tetsuo-900 rounded-xl border border-tetsuo-800 overflow-hidden">
      {/* Success Header */}
      <div className="p-8 bg-gradient-to-br from-green-500/20 to-accent/20 border-b border-tetsuo-800">
        <div className="text-center">
          <div className="w-20 h-20 bg-green-500/30 rounded-full flex items-center justify-center mx-auto">
            <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-4 text-2xl font-bold text-tetsuo-100">Private Task Completed!</h2>
          <p className="mt-2 text-tetsuo-400">
            The entire flow was executed with privacy preserved at every step.
          </p>
        </div>
      </div>

      {/* Summary Content */}
      <div className="p-6 space-y-6">
        {/* Transaction Summary */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-tetsuo-200">Transaction Summary</h3>

          <div className="grid gap-3">
            {/* Create Task */}
            <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-accent/20 rounded-full flex items-center justify-center">
                    <span className="text-accent text-sm font-medium">1</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-tetsuo-200">Create Task</p>
                    <p className="text-xs text-tetsuo-500">{taskState.requirements}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-tetsuo-400">
                    {taskState.txSignatures?.createTask?.slice(0, 16)}...
                  </p>
                </div>
              </div>
            </div>

            {/* Shield Escrow */}
            <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-accent/20 rounded-full flex items-center justify-center">
                    <span className="text-accent text-sm font-medium">2</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-tetsuo-200">Shield Escrow</p>
                    <p className="text-xs text-tetsuo-500">{taskState.escrowAmount} SOL into Privacy Pool</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-tetsuo-400">
                    {taskState.txSignatures?.shieldEscrow?.slice(0, 16)}...
                  </p>
                </div>
              </div>
            </div>

            {/* Claim Task */}
            <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-accent/20 rounded-full flex items-center justify-center">
                    <span className="text-accent text-sm font-medium">3</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-tetsuo-200">Claim Task</p>
                    <p className="text-xs text-tetsuo-500">Agent: {taskState.workerPubkey}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-tetsuo-400">
                    {taskState.txSignatures?.claimTask?.slice(0, 16)}...
                  </p>
                </div>
              </div>
            </div>

            {/* Verify Proof */}
            <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-accent/20 rounded-full flex items-center justify-center">
                    <span className="text-accent text-sm font-medium">4</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-tetsuo-200">Verify ZK Proof</p>
                    <p className="text-xs text-tetsuo-500">Groth16 proof verified on-chain</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-tetsuo-400">
                    {taskState.txSignatures?.verifyProof?.slice(0, 16)}...
                  </p>
                </div>
              </div>
            </div>

            {/* Withdraw */}
            <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-green-500/20 rounded-full flex items-center justify-center">
                    <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-tetsuo-200">Private Withdraw</p>
                    <p className="text-xs text-tetsuo-500">To: {taskState.recipientPubkey}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-tetsuo-400">
                    {taskState.txSignatures?.withdraw?.slice(0, 16)}...
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Privacy Stats */}
        <div className="p-6 bg-gradient-to-br from-accent/10 to-green-500/10 rounded-lg border border-accent/30">
          <h4 className="text-sm font-medium text-accent-light mb-4">Privacy Achieved</h4>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-2xl font-bold text-tetsuo-100">100%</p>
              <p className="text-xs text-tetsuo-500">Link Privacy</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-tetsuo-100">0</p>
              <p className="text-xs text-tetsuo-500">Leaked Data Points</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-tetsuo-100">528</p>
              <p className="text-xs text-tetsuo-500">Proof Size (bytes)</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-tetsuo-100">4</p>
              <p className="text-xs text-tetsuo-500">Public Witness Fields</p>
            </div>
          </div>
        </div>

        {/* What's Hidden */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
            <h4 className="text-sm font-medium text-tetsuo-200 mb-3">Publicly Visible</h4>
            <ul className="text-xs text-tetsuo-400 space-y-2">
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-tetsuo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Task ID
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-tetsuo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Constraint Hash
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-tetsuo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Output Commitment
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-tetsuo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Worker Pubkey Hash
              </li>
            </ul>
          </div>
          <div className="p-4 bg-green-500/10 rounded-lg border border-green-500/30">
            <h4 className="text-sm font-medium text-green-400 mb-3">Kept Private</h4>
            <ul className="text-xs text-tetsuo-400 space-y-2">
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Actual Task Output
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Payment Recipient Link
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Salt Value
              </li>
              <li className="flex items-center gap-2">
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Creator Identity
              </li>
            </ul>
          </div>
        </div>

        {/* Tech Stack */}
        <div className="p-4 bg-tetsuo-800/30 rounded-lg border border-tetsuo-700">
          <h4 className="text-sm font-medium text-tetsuo-300 mb-3">Technology Stack</h4>
          <div className="flex flex-wrap gap-2">
            <span className="px-3 py-1 bg-tetsuo-800 rounded-full text-xs text-tetsuo-400">Noir Circuits</span>
            <span className="px-3 py-1 bg-tetsuo-800 rounded-full text-xs text-tetsuo-400">Groth16 Proofs</span>
            <span className="px-3 py-1 bg-tetsuo-800 rounded-full text-xs text-tetsuo-400">Sunspot Verifier</span>
            <span className="px-3 py-1 bg-tetsuo-800 rounded-full text-xs text-tetsuo-400">Privacy Cash</span>
            <span className="px-3 py-1 bg-tetsuo-800 rounded-full text-xs text-tetsuo-400">Poseidon2 Hash</span>
            <span className="px-3 py-1 bg-tetsuo-800 rounded-full text-xs text-tetsuo-400">Solana Devnet</span>
          </div>
        </div>

        {/* Reset Button */}
        <button
          onClick={onReset}
          className="w-full py-3 bg-accent hover:bg-accent-dark text-white font-medium rounded-lg
                     transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Run Demo Again
        </button>
      </div>
    </div>
  )
}
