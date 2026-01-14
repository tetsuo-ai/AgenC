import { ReactNode } from 'react'

interface Props {
  title: string
  description: string
  icon: ReactNode
  children: ReactNode
}

export default function StepCard({ title, description, icon, children }: Props) {
  return (
    <div className="bg-tetsuo-900 rounded-xl border border-tetsuo-800 overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-tetsuo-800">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-accent/20 rounded-lg flex items-center justify-center text-accent shrink-0">
            {icon}
          </div>
          <div>
            <h2 className="text-xl font-semibold text-tetsuo-100">{title}</h2>
            <p className="mt-1 text-sm text-tetsuo-400">{description}</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {children}
      </div>
    </div>
  )
}
