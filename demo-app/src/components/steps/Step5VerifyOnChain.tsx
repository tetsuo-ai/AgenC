import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

const FALLBACK_ROUTER_PROGRAM = '6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7'
const FALLBACK_ROUTER = '8v7xftANnyJTrmQfk9kYV8NsxgV2wNt2Y5soiceqd7qN'
const FALLBACK_VERIFIER_ENTRY = 'DSjWTAx5N4oXfTy5m9BbqbMPUq5BkzFG6xzn2fJfVj8S'
const FALLBACK_VERIFIER_PROGRAM = 'THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge'

function formatHexLength(hexValue: string): number {
  if (!hexValue || !hexValue.startsWith('0x')) {
    return 0
  }
  return (hexValue.length - 2) / 2
}

export default function Step5VerifyOnChain({ taskState, updateTaskState, onNext, onPrev }: StepProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [verificationStage, setVerificationStage] = useState<'idle' | 'submitting' | 'routing' | 'verifying' | 'confirmed'>('idle')

  const routerProgram = taskState.routerProgram || FALLBACK_ROUTER_PROGRAM
  const router = taskState.router || FALLBACK_ROUTER
  const verifierEntry = taskState.verifierEntry || FALLBACK_VERIFIER_ENTRY
  const verifierProgram = taskState.verifierProgram || FALLBACK_VERIFIER_PROGRAM

  const handleVerify = async () => {
    setIsProcessing(true)

    setVerificationStage('submitting')
    await new Promise(resolve => setTimeout(resolve, 900))

    setVerificationStage('routing')
    await new Promise(resolve => setTimeout(resolve, 1000))

    setVerificationStage('verifying')
    await new Promise(resolve => setTimeout(resolve, 1200))

    setVerificationStage('confirmed')
    await new Promise(resolve => setTimeout(resolve, 400))

    updateTaskState({
      txSignatures: {
        ...taskState.txSignatures,
        verifyProof: 'sim_' + Math.random().toString(36).substring(2, 15),
      },
    })

    setIsProcessing(false)
    onNext()
  }

  return (
    <StepCard
      title="Verify On-Chain"
      description="Submit complete_task_private with the RISC0 payload, router accounts, and spend PDAs."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
        </svg>
      }
    >
      <div className="space-y-6">
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <div className="grid gap-2 text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-36">routerProgram:</span>
              <span className="text-tetsuo-300 truncate">{routerProgram}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-36">router:</span>
              <span className="text-tetsuo-300 truncate">{router}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-36">verifierEntry:</span>
              <span className="text-tetsuo-300 truncate">{verifierEntry}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-36">verifierProgram:</span>
              <span className="text-tetsuo-300 truncate">{verifierProgram}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-36">bindingSpend:</span>
              <span className="text-tetsuo-300 truncate">{taskState.bindingSpend || 'pending from Step 4'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-36">nullifierSpend:</span>
              <span className="text-tetsuo-300 truncate">{taskState.nullifierSpend || 'pending from Step 4'}</span>
            </div>
          </div>
        </div>

        <div className="p-6 bg-gradient-to-br from-tetsuo-800 to-tetsuo-900 rounded-lg border border-tetsuo-700">
          <div className="flex items-center justify-between">
            <div className="text-center">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center ${verificationStage !== 'idle' ? 'bg-accent/30' : 'bg-tetsuo-700'}`}>
                <svg className="w-7 h-7 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="mt-2 text-xs text-tetsuo-500">Worker</p>
            </div>

            <div className="flex-1 flex items-center px-2">
              <div className={`h-0.5 flex-1 transition-all duration-500 ${verificationStage === 'submitting' || verificationStage === 'routing' || verificationStage === 'verifying' || verificationStage === 'confirmed' ? 'bg-accent' : 'bg-tetsuo-700'}`} />
              <span className={`mx-2 text-xs whitespace-nowrap ${verificationStage === 'submitting' ? 'text-accent animate-pulse' : 'text-tetsuo-600'}`}>
                payload + accounts
              </span>
              <div className={`h-0.5 flex-1 transition-all duration-500 ${verificationStage === 'submitting' || verificationStage === 'routing' || verificationStage === 'verifying' || verificationStage === 'confirmed' ? 'bg-accent' : 'bg-tetsuo-700'}`} />
            </div>

            <div className="text-center">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${verificationStage === 'routing' ? 'bg-accent/30 animate-pulse-glow' : verificationStage === 'confirmed' ? 'bg-green-500/30' : 'bg-tetsuo-700'}`}>
                {verificationStage === 'confirmed' ? (
                  <svg className="w-7 h-7 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className={`w-7 h-7 ${verificationStage === 'routing' || verificationStage === 'verifying' ? 'text-accent' : 'text-tetsuo-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                  </svg>
                )}
              </div>
              <p className={`mt-2 text-xs ${verificationStage === 'confirmed' ? 'text-green-400' : 'text-tetsuo-500'}`}>
                {verificationStage === 'confirmed' ? 'Verified' : 'Router'}
              </p>
            </div>
          </div>

          <div className="mt-6 text-center">
            {verificationStage === 'idle' && (
              <p className="text-sm text-tetsuo-400">Ready to submit complete_task_private</p>
            )}
            {verificationStage === 'submitting' && (
              <p className="text-sm text-accent animate-pulse">Submitting transaction...</p>
            )}
            {verificationStage === 'routing' && (
              <p className="text-sm text-accent animate-pulse">Router validating selector and verifier entry...</p>
            )}
            {verificationStage === 'verifying' && (
              <p className="text-sm text-accent animate-pulse">Verifier checking seal/journal/image...</p>
            )}
            {verificationStage === 'confirmed' && (
              <p className="text-sm text-green-400">Proof accepted and reward path unlocked</p>
            )}
          </div>
        </div>

        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <h4 className="text-sm font-medium text-tetsuo-200 mb-3">Payload preview</h4>
          <div className="space-y-2 font-mono text-xs">
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-32">sealBytes:</span>
              <span className="text-tetsuo-300 truncate">{formatHexLength(taskState.sealBytes)} bytes</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-32">journal:</span>
              <span className="text-tetsuo-300 truncate">{formatHexLength(taskState.journal)} bytes</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-32">imageId:</span>
              <span className="text-tetsuo-300 truncate">{taskState.imageId ? `${taskState.imageId.slice(0, 20)}...` : 'missing'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-32">bindingSeed:</span>
              <span className="text-tetsuo-300 truncate">{taskState.bindingSeed ? `${taskState.bindingSeed.slice(0, 20)}...` : 'missing'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-32">nullifierSeed:</span>
              <span className="text-tetsuo-300 truncate">{taskState.nullifierSeed ? `${taskState.nullifierSeed.slice(0, 20)}...` : 'missing'}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          <button
            onClick={onPrev}
            className="px-6 py-3 bg-tetsuo-800 hover:bg-tetsuo-700 text-tetsuo-300 font-medium rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleVerify}
            disabled={isProcessing}
            className="flex-1 py-3 bg-accent hover:bg-accent-dark disabled:bg-tetsuo-700 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Verifying...
              </>
            ) : (
              <>
                Verify On-Chain
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
