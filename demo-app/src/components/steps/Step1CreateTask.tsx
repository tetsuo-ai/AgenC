import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

export default function Step1CreateTask({ taskState, updateTaskState, onNext }: StepProps) {
  const [requirements, setRequirements] = useState(taskState.requirements || 'Compute the sum of [1, 2, 3, 4]')
  const [escrowAmount, setEscrowAmount] = useState(taskState.escrowAmount || 0.1)
  const [isProcessing, setIsProcessing] = useState(false)

  const handleCreate = async () => {
    setIsProcessing(true)

    // Simulate task creation
    await new Promise(resolve => setTimeout(resolve, 1500))

    // Generate mock data
    const taskId = 'task_' + Math.random().toString(36).substring(2, 10)
    const constraintHash = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')

    updateTaskState({
      taskId,
      requirements,
      escrowAmount,
      constraintHash,
      outputCommitment: '',
      sealBytes: '',
      journal: '',
      imageId: '',
      bindingSeed: '',
      nullifierSeed: '',
      routerProgram: '',
      router: '',
      verifierEntry: '',
      verifierProgram: '',
      bindingSpend: '',
      nullifierSpend: '',
      txSignatures: {
        ...taskState.txSignatures,
        createTask: 'sim_' + Math.random().toString(36).substring(2, 15),
      },
    })

    setIsProcessing(false)
    onNext()
  }

  return (
    <StepCard
      title="Create Task"
      description="Define task requirements and set escrow amount. The constraint hash is the public anchor for the later RISC0 journal and spend-seed checks."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      }
    >
      <div className="space-y-6">
        {/* Task Requirements */}
        <div>
          <label className="block text-sm font-medium text-tetsuo-300 mb-2">
            Task Requirements
          </label>
          <textarea
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            className="w-full px-4 py-3 bg-tetsuo-800 border border-tetsuo-700 rounded-lg
                       text-tetsuo-100 placeholder-tetsuo-500 focus:outline-none focus:border-accent
                       resize-none h-24"
            placeholder="Describe what the agent needs to compute..."
          />
          <p className="mt-1 text-xs text-tetsuo-500">
            The actual expected output is kept secret. Only a hash is published.
          </p>
        </div>

        {/* Escrow Amount */}
        <div>
          <label className="block text-sm font-medium text-tetsuo-300 mb-2">
            Escrow Amount (SOL)
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0.01"
              max="1"
              step="0.01"
              value={escrowAmount}
              onChange={(e) => setEscrowAmount(parseFloat(e.target.value))}
              className="flex-1 accent-accent"
            />
            <div className="w-24 px-3 py-2 bg-tetsuo-800 border border-tetsuo-700 rounded-lg text-center">
              <span className="text-lg font-mono text-accent-light">{escrowAmount.toFixed(2)}</span>
              <span className="text-xs text-tetsuo-500 ml-1">SOL</span>
            </div>
          </div>
        </div>

        {/* Info Box */}
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <h4 className="text-sm font-medium text-tetsuo-200 mb-2">What happens:</h4>
          <ul className="text-sm text-tetsuo-400 space-y-1">
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Task is created on-chain with constraint hash
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Escrow account is initialized
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Expected output remains private
            </li>
          </ul>
        </div>

        {/* Create Button */}
        <button
          onClick={handleCreate}
          disabled={isProcessing || !requirements}
          className="w-full py-3 bg-accent hover:bg-accent-dark disabled:bg-tetsuo-700
                     text-white font-medium rounded-lg transition-colors
                     flex items-center justify-center gap-2"
        >
          {isProcessing ? (
            <>
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Creating Task...
            </>
          ) : (
            <>
              Create Task
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </>
          )}
        </button>
      </div>
    </StepCard>
  )
}
