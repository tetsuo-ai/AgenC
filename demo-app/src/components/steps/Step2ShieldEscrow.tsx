import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

export default function Step2ShieldEscrow({ taskState, updateTaskState, onNext, onPrev }: StepProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)

  const handleShield = async () => {
    setIsProcessing(true)
    setProgress(0)

    // Simulate shielding with progress
    for (let i = 0; i <= 100; i += 10) {
      await new Promise(resolve => setTimeout(resolve, 200))
      setProgress(i)
    }

    updateTaskState({
      txSignatures: {
        ...taskState.txSignatures,
        shieldEscrow: 'sim_' + Math.random().toString(36).substring(2, 15),
      },
    })

    setIsProcessing(false)
    onNext()
  }

  return (
    <StepCard
      title="Shield Escrow"
      description="Move escrow funds into the Privacy Cash pool. This breaks the link between the task creator and eventual payment recipient."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      }
    >
      <div className="space-y-6">
        {/* Task Summary */}
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-tetsuo-500">Task ID</span>
              <p className="font-mono text-tetsuo-200 truncate">{taskState.taskId}</p>
            </div>
            <div>
              <span className="text-tetsuo-500">Amount</span>
              <p className="font-mono text-accent-light">{taskState.escrowAmount} SOL</p>
            </div>
          </div>
        </div>

        {/* Privacy Pool Visualization */}
        <div className="relative p-6 bg-gradient-to-br from-tetsuo-800 to-tetsuo-900 rounded-lg border border-tetsuo-700">
          <div className="flex items-center justify-between">
            {/* Creator */}
            <div className="text-center">
              <div className="w-16 h-16 bg-tetsuo-700 rounded-full flex items-center justify-center mx-auto">
                <svg className="w-8 h-8 text-tetsuo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <p className="mt-2 text-xs text-tetsuo-500">Creator</p>
            </div>

            {/* Arrow */}
            <div className="flex-1 flex items-center justify-center">
              <div className={`h-0.5 flex-1 max-w-16 ${isProcessing ? 'bg-accent animate-pulse' : 'bg-tetsuo-700'}`} />
              <svg className={`w-6 h-6 mx-2 ${isProcessing ? 'text-accent animate-bounce' : 'text-tetsuo-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
              <div className={`h-0.5 flex-1 max-w-16 ${isProcessing ? 'bg-accent animate-pulse' : 'bg-tetsuo-700'}`} />
            </div>

            {/* Privacy Pool */}
            <div className="text-center">
              <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto transition-all
                             ${isProcessing ? 'bg-accent/30 animate-pulse-glow' : 'bg-accent/20'}`}>
                <svg className="w-8 h-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <p className="mt-2 text-xs text-accent-light">Privacy Pool</p>
            </div>
          </div>

          {/* Progress bar */}
          {isProcessing && (
            <div className="mt-6">
              <div className="h-2 bg-tetsuo-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-center text-tetsuo-400">Shielding funds... {progress}%</p>
            </div>
          )}
        </div>

        {/* Privacy Info */}
        <div className="p-4 bg-accent/10 rounded-lg border border-accent/30">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-accent mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-sm">
              <p className="text-accent-light font-medium">Privacy Protection</p>
              <p className="text-tetsuo-400 mt-1">
                Once shielded, there's no on-chain link between your deposit and the eventual withdrawal.
                The Privacy Cash pool mixes funds from multiple users.
              </p>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex gap-4">
          <button
            onClick={onPrev}
            className="px-6 py-3 bg-tetsuo-800 hover:bg-tetsuo-700 text-tetsuo-300
                       font-medium rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleShield}
            disabled={isProcessing}
            className="flex-1 py-3 bg-accent hover:bg-accent-dark disabled:bg-tetsuo-700
                       text-white font-medium rounded-lg transition-colors
                       flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Shielding...
              </>
            ) : (
              <>
                Shield Escrow
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </StepCard>
  )
}
