export function isPendingAgentStreamState(streamState) {
  return streamState === "streaming" || streamState === "pending-final";
}

export function nextAgentStreamState({ done = false } = {}) {
  return done ? "pending-final" : "streaming";
}

export function findLatestPendingAgentEvent(events) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (candidate?.kind === "agent" && isPendingAgentStreamState(candidate.streamState)) {
      return candidate;
    }
  }
  return null;
}
