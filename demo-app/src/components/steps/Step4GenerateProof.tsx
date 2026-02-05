import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

const PROOF_STAGES = [
  { id: 1, label: 'Computing output', duration: 800 },
  { id: 2, label: 'Generating witness', duration: 1000 },
  { id: 3, label: 'Creating ZK proof', duration: 1500 },
  { id: 4, label: 'Optimizing for TX size', duration: 500 },
]

export default function Step4GenerateProof({ updateTaskState, onNext, onPrev }: StepProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentStage, setCurrentStage] = useState(0)
  const [proofStats, setProofStats] = useState({
    proofSize: 0,
    witnessSize: 0,
    totalSize: 0,
  })

  const handleGenerate = async () => {
    setIsProcessing(true)
    setCurrentStage(0)

    // Simulate proof generation stages
    for (let i = 0; i < PROOF_STAGES.length; i++) {
      setCurrentStage(i + 1)
      await new Promise(resolve => setTimeout(resolve, PROOF_STAGES[i].duration))
    }

    // Set proof stats (optimized sizes)
    setProofStats({
      proofSize: 388,
      witnessSize: 140,
      totalSize: 528,
    })

    const outputCommitment = '0x' + Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')

    const proofData = '0x' + Array.from({ length: 776 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')

    updateTaskState({
      outputCommitment,
      proofData,
    })

    setIsProcessing(false)
    onNext()
  }

  return (
    <StepCard
      title="Generate ZK Proof"
      description="The agent computes the task output and generates a zero-knowledge proof. The output is never revealed."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      }
    >
      <div className="space-y-6">
        {/* Proof Generation Visualization */}
        <div className="p-6 bg-gradient-to-br from-tetsuo-800 to-tetsuo-900 rounded-lg border border-tetsuo-700">
          {/* Circuit diagram */}
          <div className="flex items-center justify-center gap-4 mb-6">
            <div className="text-center">
              <div className="w-12 h-12 bg-tetsuo-700 rounded-lg flex items-center justify-center">
                <span className="text-xl">📥</span>
              </div>
              <p className="mt-1 text-xs text-tetsuo-500">Private Input</p>
            </div>
            <svg className="w-8 h-8 text-tetsuo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="text-center">
              <div className={`w-16 h-16 rounded-lg flex items-center justify-center transition-all
                             ${isProcessing ? 'bg-accent/30 animate-pulse' : 'bg-accent/20'}`}>
                <span className="text-2xl">🔐</span>
              </div>
              <p className="mt-1 text-xs text-accent-light">Noir Circuit</p>
            </div>
            <svg className="w-8 h-8 text-tetsuo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="text-center">
              <div className="w-12 h-12 bg-tetsuo-700 rounded-lg flex items-center justify-center">
                <span className="text-xl">📤</span>
              </div>
              <p className="mt-1 text-xs text-tetsuo-500">ZK Proof</p>
            </div>
          </div>

          {/* Progress stages */}
          <div className="space-y-3">
            {PROOF_STAGES.map((stage, index) => (
              <div key={stage.id} className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs
                               ${currentStage > index ? 'bg-green-500 text-white' :
                                 currentStage === index + 1 ? 'bg-accent text-white animate-pulse' :
                                 'bg-tetsuo-700 text-tetsuo-500'}`}>
                  {currentStage > index ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    stage.id
                  )}
                </div>
                <span className={`text-sm ${currentStage >= index + 1 ? 'text-tetsuo-200' : 'text-tetsuo-500'}`}>
                  {stage.label}
                </span>
                {currentStage === index + 1 && (
                  <div className="flex-1 h-1 bg-tetsuo-700 rounded-full overflow-hidden">
                    <div className="h-full bg-accent animate-pulse" style={{ width: '60%' }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* TX Size Optimization */}
        <div className="p-4 bg-green-500/10 rounded-lg border border-green-500/30">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-green-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <p className="text-green-400 font-medium text-sm">TX Size Optimized</p>
              <p className="text-tetsuo-400 text-sm mt-1">
                Using hashed pubkey reduces public witness from 1132 to 140 bytes.
              </p>
              {proofStats.totalSize > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-lg font-mono text-tetsuo-200">{proofStats.proofSize}</p>
                    <p className="text-xs text-tetsuo-500">Proof bytes</p>
                  </div>
                  <div>
                    <p className="text-lg font-mono text-tetsuo-200">{proofStats.witnessSize}</p>
                    <p className="text-xs text-tetsuo-500">Witness bytes</p>
                  </div>
                  <div>
                    <p className="text-lg font-mono text-green-400">{proofStats.totalSize}</p>
                    <p className="text-xs text-tetsuo-500">Total (limit: 1232)</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* What's proven */}
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <h4 className="text-sm font-medium text-tetsuo-200 mb-2">The proof demonstrates:</h4>
          <ul className="text-sm text-tetsuo-400 space-y-1">
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Agent knows output matching constraint hash
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Output commitment is correctly formed
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full" />
              Proof is bound to this specific agent
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
            onClick={handleGenerate}
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
                Generating Proof...
              </>
            ) : (
              <>
                Generate ZK Proof
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
