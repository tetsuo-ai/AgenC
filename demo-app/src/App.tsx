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

export interface StepProps {
  taskState: TaskState
  updateTaskState: (updates: Partial<TaskState>) => void
  onNext: () => void
  onPrev: () => void
  connection: Connection | null
}

export interface TaskState {
  taskId: string
  requirements: string
  escrowAmount: number
  constraintHash: string
  outputCommitment: string
  workerPubkey: string
  recipientPubkey: string
  sealBytes: string
  journal: string
  imageId: string
  bindingSeed: string
  nullifierSeed: string
  routerProgram: string
  router: string
  verifierEntry: string
  verifierProgram: string
  bindingSpend: string
  nullifierSpend: string
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

// Trusted RPC endpoints allowlist for production security
const TRUSTED_RPC_DOMAINS = [
  'api.devnet.solana.com',
  'api.testnet.solana.com',
  'api.mainnet-beta.solana.com',
  'localhost',
  '127.0.0.1',
]

// RPC endpoint configuration - use environment variable with fallback for demo
// Security: Validate and sanitize RPC URL to prevent injection attacks
const getRpcEndpoint = (): string => {
  const customRpc = import.meta.env.VITE_SOLANA_RPC_URL
  const defaultRpc = 'https://api.devnet.solana.com'

  if (!customRpc) {
    return defaultRpc
  }

  try {
    const url = new URL(customRpc)

    // Security: Only allow http/https protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.error('[Security] Invalid RPC URL protocol. Using default endpoint.')
      return defaultRpc
    }

    // Security: Warn if non-HTTPS endpoint is used in production-like environment
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !isLocalhost) {
      console.warn('[Security] Non-HTTPS RPC endpoint detected. Use HTTPS in production.')
    }

    // Security: Check if domain is in trusted allowlist (configurable via env)
    const allowCustomDomains = import.meta.env.VITE_ALLOW_CUSTOM_RPC === 'true'
    const isTrustedDomain = TRUSTED_RPC_DOMAINS.some(domain => {
      if (url.hostname === domain) return true;
      // For subdomains, ensure the trusted domain is a proper suffix
      // Skip subdomain matching for localhost-like domains to prevent DNS rebinding
      if (domain === 'localhost' || domain === '127.0.0.1') return false;
      return url.hostname.endsWith('.' + domain);
    })

    if (!isTrustedDomain && !allowCustomDomains) {
      console.warn('[Security] RPC URL domain not in trusted allowlist. Set VITE_ALLOW_CUSTOM_RPC=true to allow custom domains.')
      return defaultRpc
    }

    return customRpc
  } catch {
    console.error('[Security] Invalid RPC URL format. Using default endpoint.')
    return defaultRpc
  }
}

const DEVNET_RPC = getRpcEndpoint()

// Transaction confirmation timeout - configurable via VITE_TX_TIMEOUT env var
const TX_TIMEOUT_MS = (() => {
  const timeout = Number(import.meta.env.VITE_TX_TIMEOUT);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 60000;
})();

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
    txSignatures: {},
  })

  // Initialize connection with error handling
  const initializeConnection = useCallback(async () => {
    setConnectionState(prev => ({ ...prev, isConnecting: true, error: null }))
    try {
      const conn = new Connection(DEVNET_RPC, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: TX_TIMEOUT_MS,
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
      txSignatures: {},
    })
    // Re-initialize connection to ensure clean state
    initializeConnection()
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
