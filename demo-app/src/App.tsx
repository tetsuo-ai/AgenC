import { useState, useEffect, useCallback } from 'react'
import { Connection } from '@solana/web3.js'
import Header from './components/Header'
import StepIndicator from './components/StepIndicator'
import Step1CreateTask from './components/steps/Step1CreateTask'
import Step2ShieldEscrow from './components/steps/Step2ShieldEscrow'
import Step3ClaimTask from './components/steps/Step3ClaimTask'
import Step4GenerateProof from './components/steps/Step4GenerateProof'
import Step5VerifyOnChain from './components/steps/Step5VerifyOnChain'
import Step6PrivateWithdraw from './components/steps/Step6PrivateWithdraw'
import CompletionSummary from './components/CompletionSummary'

export interface TaskState {
  taskId: string
  requirements: string
  escrowAmount: number
  constraintHash: string
  outputCommitment: string
  workerPubkey: string
  recipientPubkey: string
  proofData: string
  txSignatures: {
    createTask?: string
    shieldEscrow?: string
    claimTask?: string
    verifyProof?: string
    withdraw?: string
  }
}

const STEPS = [
  { id: 1, title: 'Create Task', description: 'Define requirements and escrow' },
  { id: 2, title: 'Shield Escrow', description: 'Move funds to privacy pool' },
  { id: 3, title: 'Claim Task', description: 'Agent stakes and claims' },
  { id: 4, title: 'Generate Proof', description: 'Create ZK proof of completion' },
  { id: 5, title: 'Verify On-Chain', description: 'Submit proof to verifier' },
  { id: 6, title: 'Private Withdraw', description: 'Receive unlinkable payment' },
]

// RPC endpoint configuration - use environment variable with fallback for demo
const DEVNET_RPC = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'

// Connection error state type
interface ConnectionState {
  connection: Connection | null
  error: string | null
  isConnecting: boolean
}

function App() {
  const [currentStep, setCurrentStep] = useState(1)
  const [isComplete, setIsComplete] = useState(false)
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    connection: null,
    error: null,
    isConnecting: true,
  })
  const [taskState, setTaskState] = useState<TaskState>({
    taskId: '',
    requirements: '',
    escrowAmount: 0.1,
    constraintHash: '',
    outputCommitment: '',
    workerPubkey: '',
    recipientPubkey: '',
    proofData: '',
    txSignatures: {},
  })

  // Initialize connection with error handling
  const initializeConnection = useCallback(async () => {
    setConnectionState(prev => ({ ...prev, isConnecting: true, error: null }))
    try {
      const conn = new Connection(DEVNET_RPC, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
      })
      // Verify connection is working by fetching slot
      await conn.getSlot()
      setConnectionState({ connection: conn, error: null, isConnecting: false })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to connect to Solana network'
      console.error('Connection initialization failed:', errorMessage)
      setConnectionState({ connection: null, error: errorMessage, isConnecting: false })
    }
  }, [])

  useEffect(() => {
    initializeConnection()
  }, [initializeConnection])

  // Provide connection from state for backward compatibility
  const connection = connectionState.connection

  const handleNextStep = () => {
    if (currentStep < 6) {
      setCurrentStep(currentStep + 1)
    } else {
      setIsComplete(true)
    }
  }

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleReset = () => {
    setCurrentStep(1)
    setIsComplete(false)
    setTaskState({
      taskId: '',
      requirements: '',
      escrowAmount: 0.1,
      constraintHash: '',
      outputCommitment: '',
      workerPubkey: '',
      recipientPubkey: '',
      proofData: '',
      txSignatures: {},
    })
  }

  const updateTaskState = (updates: Partial<TaskState>) => {
    setTaskState(prev => ({ ...prev, ...updates }))
  }

  const renderStep = () => {
    const props = {
      taskState,
      updateTaskState,
      onNext: handleNextStep,
      onPrev: handlePrevStep,
      connection,
    }

    switch (currentStep) {
      case 1:
        return <Step1CreateTask {...props} />
      case 2:
        return <Step2ShieldEscrow {...props} />
      case 3:
        return <Step3ClaimTask {...props} />
      case 4:
        return <Step4GenerateProof {...props} />
      case 5:
        return <Step5VerifyOnChain {...props} />
      case 6:
        return <Step6PrivateWithdraw {...props} />
      default:
        return null
    }
  }

  if (isComplete) {
    return (
      <div className="min-h-screen bg-tetsuo-950">
        <Header />
        <CompletionSummary taskState={taskState} onReset={handleReset} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-tetsuo-950">
      <Header />

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Step indicator */}
        <StepIndicator steps={STEPS} currentStep={currentStep} />

        {/* Current step content */}
        <div className="mt-8 animate-slide-up" key={currentStep}>
          {renderStep()}
        </div>

        {/* Network indicator with connection status */}
        <div className="fixed bottom-4 right-4 flex items-center gap-2 px-3 py-2 bg-tetsuo-800 rounded-lg border border-tetsuo-700">
          {connectionState.isConnecting ? (
            <>
              <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
              <span className="text-xs text-tetsuo-400">Connecting...</span>
            </>
          ) : connectionState.error ? (
            <>
              <div className="w-2 h-2 bg-red-500 rounded-full" />
              <span className="text-xs text-red-400">Disconnected</span>
              <button
                onClick={initializeConnection}
                className="text-xs text-tetsuo-300 hover:text-white underline ml-1"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs text-tetsuo-400">Devnet</span>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
