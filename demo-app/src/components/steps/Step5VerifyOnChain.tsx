import { useState } from 'react'
import type { StepProps } from '../../App'
import StepCard from '../StepCard'

const VERIFIER_PROGRAM = '8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ'

export default function Step5VerifyOnChain({ taskState, updateTaskState, onNext, onPrev }: StepProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [verificationStage, setVerificationStage] = useState<'idle' | 'submitting' | 'verifying' | 'confirmed'>('idle')

  const handleVerify = async () => {
    setIsProcessing(true)

    // Stage 1: Submitting
    setVerificationStage('submitting')
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Stage 2: Verifying
    setVerificationStage('verifying')
    await new Promise(resolve => setTimeout(resolve, 1500))

    // Stage 3: Confirmed
    setVerificationStage('confirmed')
    await new Promise(resolve => setTimeout(resolve, 500))

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
      description="Submit the ZK proof to the Sunspot verifier program. The verifier checks the proof without learning the private inputs."
      icon={
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
        </svg>
      }
    >
      <div className="space-y-6">
        {/* Verifier Program Info */}
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent/20 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-tetsuo-400">Sunspot Verifier (Devnet)</p>
              <p className="font-mono text-xs text-tetsuo-500 truncate">{VERIFIER_PROGRAM}</p>
            </div>
            <a
              href={`https://explorer.solana.com/address/${VERIFIER_PROGRAM}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-light"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>

        {/* Verification Flow */}
        <div className="p-6 bg-gradient-to-br from-tetsuo-800 to-tetsuo-900 rounded-lg border border-tetsuo-700">
          <div className="flex items-center justify-between">
            {/* Agent */}
            <div className="text-center">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center
                             ${verificationStage !== 'idle' ? 'bg-accent/30' : 'bg-tetsuo-700'}`}>
                <svg className="w-7 h-7 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="mt-2 text-xs text-tetsuo-500">Agent</p>
            </div>

            {/* Arrow 1 */}
            <div className="flex-1 flex items-center px-2">
              <div className={`h-0.5 flex-1 transition-all duration-500
                             ${verificationStage === 'submitting' || verificationStage === 'verifying' || verificationStage === 'confirmed'
                               ? 'bg-accent' : 'bg-tetsuo-700'}`} />
              <span className={`mx-2 text-xs whitespace-nowrap
                              ${verificationStage === 'submitting' ? 'text-accent animate-pulse' : 'text-tetsuo-600'}`}>
                proof + witness
              </span>
              <div className={`h-0.5 flex-1 transition-all duration-500
                             ${verificationStage === 'submitting' || verificationStage === 'verifying' || verificationStage === 'confirmed'
                               ? 'bg-accent' : 'bg-tetsuo-700'}`} />
            </div>

            {/* Verifier */}
            <div className="text-center">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-all
                             ${verificationStage === 'verifying' ? 'bg-accent/30 animate-pulse-glow' :
                               verificationStage === 'confirmed' ? 'bg-green-500/30' : 'bg-tetsuo-700'}`}>
                {verificationStage === 'confirmed' ? (
                  <svg className="w-7 h-7 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className={`w-7 h-7 ${verificationStage === 'verifying' ? 'text-accent' : 'text-tetsuo-500'}`}
                       fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                )}
              </div>
              <p className={`mt-2 text-xs ${verificationStage === 'confirmed' ? 'text-green-400' : 'text-tetsuo-500'}`}>
                {verificationStage === 'confirmed' ? 'Verified!' : 'Verifier'}
              </p>
            </div>
          </div>

          {/* Status message */}
          <div className="mt-6 text-center">
            {verificationStage === 'idle' && (
              <p className="text-sm text-tetsuo-400">Ready to submit proof for verification</p>
            )}
            {verificationStage === 'submitting' && (
              <p className="text-sm text-accent animate-pulse">Submitting transaction...</p>
            )}
            {verificationStage === 'verifying' && (
              <p className="text-sm text-accent animate-pulse">Verifying Groth16 proof (CPI)...</p>
            )}
            {verificationStage === 'confirmed' && (
              <p className="text-sm text-green-400">Proof verified successfully!</p>
            )}
          </div>
        </div>

        {/* Proof Data Preview */}
        <div className="p-4 bg-tetsuo-800/50 rounded-lg border border-tetsuo-700">
          <h4 className="text-sm font-medium text-tetsuo-200 mb-3">Public Witness (4 fields)</h4>
          <div className="space-y-2 font-mono text-xs">
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-28">task_id:</span>
              <span className="text-tetsuo-300 truncate">{taskState.taskId}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-28">pubkey_hash:</span>
              <span className="text-tetsuo-300 truncate">{taskState.workerPubkey ? 'hash(' + taskState.workerPubkey + ')' : '...'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-28">constraint:</span>
              <span className="text-tetsuo-300 truncate">{taskState.constraintHash?.slice(0, 20)}...</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-tetsuo-500 w-28">commitment:</span>
              <span className="text-tetsuo-300 truncate">{taskState.outputCommitment?.slice(0, 20)}...</span>
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
            onClick={handleVerify}
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
