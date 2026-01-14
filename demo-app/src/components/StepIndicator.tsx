interface Step {
  id: number
  title: string
  description: string
}

interface Props {
  steps: Step[]
  currentStep: number
}

export default function StepIndicator({ steps, currentStep }: Props) {
  return (
    <div className="relative">
      {/* Progress line */}
      <div className="absolute top-5 left-0 right-0 h-0.5 bg-tetsuo-800">
        <div
          className="h-full bg-accent transition-all duration-500 ease-out"
          style={{ width: `${((currentStep - 1) / (steps.length - 1)) * 100}%` }}
        />
      </div>

      {/* Steps */}
      <div className="relative flex justify-between">
        {steps.map((step) => {
          const isCompleted = step.id < currentStep
          const isCurrent = step.id === currentStep
          const isPending = step.id > currentStep

          return (
            <div key={step.id} className="flex flex-col items-center">
              {/* Circle */}
              <div
                className={`
                  w-10 h-10 rounded-full flex items-center justify-center
                  transition-all duration-300 relative z-10
                  ${isCompleted ? 'bg-accent text-white' : ''}
                  ${isCurrent ? 'bg-accent text-white animate-pulse-glow' : ''}
                  ${isPending ? 'bg-tetsuo-800 text-tetsuo-500 border-2 border-tetsuo-700' : ''}
                `}
              >
                {isCompleted ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span className="text-sm font-medium">{step.id}</span>
                )}
              </div>

              {/* Label */}
              <div className="mt-3 text-center">
                <p className={`text-sm font-medium ${isCurrent ? 'text-accent-light' : 'text-tetsuo-300'}`}>
                  {step.title}
                </p>
                <p className="text-xs text-tetsuo-500 mt-0.5 max-w-[100px] hidden sm:block">
                  {step.description}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
