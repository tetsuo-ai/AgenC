export interface RunAgencWatchCliOptions {
  readonly runWatchApp?: () => Promise<number | void> | number | void;
  readonly processLike?: {
    exit(code?: number): void;
    stderr: {
      write(message: string): void;
    };
  };
}

export function runAgencWatchCli(
  options?: RunAgencWatchCliOptions,
): Promise<void>;
