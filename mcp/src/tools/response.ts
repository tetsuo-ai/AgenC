export function toolTextResponse(text: string): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{ type: 'text', text }],
  };
}

export function toolErrorResponse(error: unknown): { content: [{ type: 'text'; text: string }] } {
  const message = error instanceof Error ? error.message : String(error);
  return toolTextResponse(`Error: ${message}`);
}
