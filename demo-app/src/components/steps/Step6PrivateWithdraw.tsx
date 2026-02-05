import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

export default function Step6PrivateWithdraw({ taskState, updateTaskState, onNext, onPrev }: StepProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [withdrawStage, setWithdrawStage] = useState<'idle' | 'generating' | 'withdrawing' | 'complete'>('idle')
  const [recipientGenerated, setRecipientGenerated] = useState(false)

  const handleWithdraw = async () => {
    setIsProcessing(true)

    // Stage 1: Generate new recipient wallet
    setWithdrawStage('generating')
    await new Promise(resolve => setTimeout(resolve, 800))
    const recipientPubkey = 'Recipient_' + Math.random().toString(36).substring(2, 10)
    updateTaskState({ recipientPubkey })
    setRecipientGenerated(true)

    // Stage 2: Withdraw
    setWithdrawStage('withdrawing')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Stage 3: Complete
    setWithdrawStage('complete')

    updateTaskState({
      txSignatures: {
        ...taskState.txSignatures,
        withdraw: 'sim_' + Math.random().toString(36).substring(2, 15),
      },
    })

    await new Promise(resolve => setTimeout(resolve, 500))
    setIsProcessing(false)
    onNext()
  }

  return (
    <StepCard
      title="Private Withdraw"
      description="Withdraw payment to a different wallet. The Privacy Cash pool ensures no link between the task creator and payment recipient."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      }
    >
      <div className="space-y-6">
        {/* Payment Flow Visualization */}
        <div className="p-6 bg-gradient-to-br from-tetsuo-800 to-tetsuo-900 rounded-lg border border-tetsuo-700">
          <div className="flex items-start justify-between">
            {/* Worker */}
            <div className="text-center flex-1">
              <div className="w-12 h-12 bg-tetsuo-700 rounded-full flex items-center justify-center mx-auto">
                <svg className="w-6 h-6 text-tetsuo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="mt-2 text-xs text-tetsuo-500">Worker</p>
              <p className="text-xs font-mono text-tetsuo-600 mt-1 truncate max-w-[80px] mx-auto">
                {taskState.workerPubkey?.slice(0, 12)}...
              </p>
            </div>

            {/* Arrow to pool */}
            <div className="flex-1 flex flex-col items-center justify-center pt-4">
              <div className="text-xs text-tetsuo-600 mb-1">proves completion</div>
              <svg className={`w-8 h-8 ${withdrawStage !== 'idle' ? 'text-accent' : 'text-tetsuo-700'}`}
                   fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </div>

            {/* Privacy Pool */}
            <div className="text-center flex-1">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto transition-all
                             ${withdrawStage === 'withdrawing' ? 'bg-accent/30 animate-pulse-glow' :
                               withdrawStage === 'complete' ? 'bg-green-500/20' : 'bg-accent/20'}`}>
                <svg className={`w-7 h-7 ${withdrawStage === 'complete' ? 'text-green-400' : 'text-accent'}`}
                     fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <p className="mt-2 text-xs text-accent-light">Privacy Pool</p>
              <p className="text-xs text-tetsuo-500 mt-1">{taskState.escrowAmount} SOL</p>
            </div>

            {/* Arrow to recipient */}
            <div className="flex-1 flex flex-col items-center justify-center pt-4">
              <div className="text-xs text-tetsuo-600 mb-1">unlinkable</div>
              <svg className={`w-8 h-8 ${withdrawStage === 'complete' ? 'text-green-400' :
                             withdrawStage === 'withdrawing' ? 'text-accent animate-pulse' : 'text-tetsuo-700'}`}
                   fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </div>

            {/* Recipient */}
            <div className="text-center flex-1">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto transition-all
                             ${recipientGenerated ? 'bg-green-500/20' : 'bg-tetsuo-700'}`}>
                <svg className={`w-6 h-6 ${recipientGenerated ? 'text-green-400' : 'text-tetsuo-500'}`}
                     fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <p className={`mt-2 text-xs ${recipientGenerated ? 'text-green-400' : 'text-tetsuo-500'}`}>
                {recipientGenerated ? 'New Wallet' : 'Recipient'}
              </p>
              {taskState.recipientPubkey && (
                <p className="text-xs font-mono text-tetsuo-600 mt-1 truncate max-w-[80px] mx-auto">
                  {taskState.recipientPubkey.slice(0, 12)}...
                </p>
              )}
            </div>
          </div>

          {/* Status */}
          <div className="mt-6 text-center">
            {withdrawStage === 'idle' && (
              <p className="text-sm text-tetsuo-400">Ready to withdraw to new wallet</p>
            )}
            {withdrawStage === 'generating' && (
              <p className="text-sm text-accent animate-pulse">Generating new recipient wallet...</p>
            )}
            {withdrawStage === 'withdrawing' && (
              <p className="text-sm text-accent animate-pulse">Processing withdrawal...</p>
            )}
            {withdrawStage === 'complete' && (
              <p className="text-sm text-green-400">Payment received!</p>
            )}
          </div>
        </div>

        {/* Privacy Guarantee */}
        <div className="p-4 bg-green-500/10 rounded-lg border border-green-500/30">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-green-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <div>
              <p className="text-green-400 font-medium text-sm">Privacy Achieved</p>
              <p className="text-tetsuo-400 text-sm mt-1">
                The task creator cannot trace the payment to the recipient wallet.
                Only the worker knows they are the same person.
              </p>
            </div>
          </div>
        </div>

        {/* What's private */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
            <h4 className="text-sm font-medium text-tetsuo-200 mb-2">On-Chain (Public)</h4>
            <ul className="text-xs text-tetsuo-400 space-y-1">
              <li>• Task ID</li>
              <li>• Constraint hash</li>
              <li>• Output commitment</li>
              <li>• Worker identity</li>
            </ul>
          </div>
          <div className="p-4 bg-accent/10 rounded-lg border border-accent/30">
            <h4 className="text-sm font-medium text-accent-light mb-2">Hidden (Private)</h4>
            <ul className="text-xs text-tetsuo-400 space-y-1">
              <li>• Actual output</li>
              <li>• Payment recipient</li>
              <li>• Creator ↔ Recipient link</li>
              <li>• Salt value</li>
            </ul>
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
            onClick={handleWithdraw}
            disabled={isProcessing}
            className="flex-1 py-3 bg-green-600 hover:bg-green-700 disabled:bg-tetsuo-700
                       text-white font-medium rounded-lg transition-colors
                       flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Processing...
              </>
            ) : (
              <>
                Withdraw Privately
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
