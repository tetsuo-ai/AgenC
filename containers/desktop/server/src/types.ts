export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ScreenshotResult {
  image: string;
  width: number;
  height: number;
}

export interface ScreenSizeResult {
  width: number;
  height: number;
}

export interface WindowInfo {
  id: string;
  title: string;
}

export interface HealthResponse {
  status: "ok";
  display: string;
  uptime: number;
}

export interface TextEditorResult {
  output: string;
}

export interface VideoRecordingState {
  pid: number;
  path: string;
  startedAt: number;
}
