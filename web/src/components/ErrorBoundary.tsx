import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
          <div className="text-red-400 text-lg font-semibold">Something went wrong</div>
          <pre className="text-tetsuo-400 text-xs max-w-md overflow-auto">
            {this.state.error?.message}
          </pre>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-accent text-white rounded text-sm hover:bg-accent-dark transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
