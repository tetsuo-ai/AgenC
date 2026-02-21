export type ToolTextResponse = { content: [{ type: "text"; text: string }] };

export function toolTextResponse(text: string): ToolTextResponse {
  return {
    content: [{ type: "text", text }],
  };
}

export function toolErrorResponse(error: unknown): ToolTextResponse {
  const message = error instanceof Error ? error.message : String(error);
  return toolTextResponse(`Error: ${message}`);
}

export function withToolErrorResponse<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<ToolTextResponse> | ToolTextResponse,
): (...args: TArgs) => Promise<ToolTextResponse> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toolErrorResponse(error);
    }
  };
}
