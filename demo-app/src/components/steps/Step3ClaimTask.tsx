import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

export default function Step3ClaimTask({ taskState, updateTaskState, onNext, onPrev }: StepProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [workerGenerated, setWorkerGenerated] = useState(false)

  const handleClaim = async () => {
    setIsProcessing(true)

    // Simulate worker keypair generation
    await new Promise(resolve => setTimeout(resolve, 500))
    const workerPubkey = 'Worker_' + Math.random().toString(36).substring(2, 10)
    setWorkerGenerated(true)

    // Simulate claim transaction
    await new Promise(resolve => setTimeout(resolve, 1500))

    updateTaskState({
      workerPubkey,
      txSignatures: {
        ...taskState.txSignatures,
        claimTask: 'sim_' + Math.random().toString(36).substring(2, 15),
      },
    })

    setIsProcessing(false)
    onNext()
  }

  return (
    <StepCard
      title="Claim Task"
      description="An agent claims the task by staking collateral. This proves commitment to completing the work."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      }
    >
      <div className="space-y-6">
        {/* Task Details */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
            <span className="text-xs text-tetsuo-500">Task Requirements</span>
            <p className="mt-1 text-sm text-tetsuo-200">{taskState.requirements}</p>
          </div>
          <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
            <span className="text-xs text-tetsuo-500">Reward</span>
            <p className="mt-1 text-lg font-mono text-accent-light">{taskState.escrowAmount} SOL</p>
          </div>
        </div>

        {/* Agent Info */}
        <div className="p-6 bg-gradient-to-br from-tetsuo-800 to-tetsuo-900 rounded-lg border border-tetsuo-700">
          <div className="flex items-center gap-4">
            <div className={`w-16 h-16 rounded-full flex items-center justify-center
                           ${workerGenerated ? 'bg-accent/30' : 'bg-tetsuo-700'}`}>
              <svg className={`w-8 h-8 ${workerGenerated ? 'text-accent' : 'text-tetsuo-500'}`}
                   fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-tetsuo-200">AI Agent</h3>
              <p className="text-sm text-tetsuo-400">
                {workerGenerated ? 'Ready to claim' : 'Generating keypair...'}
              </p>
              {taskState.workerPubkey && (
                <p className="mt-1 text-xs font-mono text-tetsuo-500">{taskState.workerPubkey}</p>
              )}
            </div>
            {workerGenerated && (
              <div className="flex items-center gap-2 px-3 py-1 bg-green-500/20 rounded-full">
                <div className="w-2 h-2 bg-green-500 rounded-full" />
                <span className="text-xs text-green-400">Online</span>
              </div>
            )}
          </div>

          {/* Stake Info */}
          <div className="mt-6 p-4 bg-tetsuo-900/50 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm text-tetsuo-400">Required Stake</span>
              <span className="font-mono text-tetsuo-200">0.01 SOL</span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-sm text-tetsuo-400">Capabilities</span>
              <span className="text-tetsuo-200">COMPUTE, INFERENCE</span>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <h4 className="text-sm font-medium text-tetsuo-200 mb-2">Claiming process:</h4>
          <ul className="text-sm text-tetsuo-400 space-y-1">
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Agent verifies it has required capabilities
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Collateral is staked (returned on success)
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Task status changes to "InProgress"
            </li>
          </ul>
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
            onClick={handleClaim}
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
                Claiming...
              </>
            ) : (
              <>
                Claim Task
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
