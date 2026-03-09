import type { BackgroundRunRecentSnapshot } from "./background-run-store.js";
import type { BackgroundRunStatusSnapshot } from "./background-run-supervisor.js";

type BackgroundRunSnapshotLike =
  | BackgroundRunStatusSnapshot
  | BackgroundRunRecentSnapshot;

function formatRelativeAge(
  timestamp: number | undefined,
  now: number,
): string | undefined {
  if (timestamp === undefined) return undefined;
  return `~${Math.max(1, Math.ceil(Math.max(0, now - timestamp) / 1000))}s ago`;
}

function formatRelativeDelay(
  timestamp: number | undefined,
  now: number,
): string | undefined {
  if (timestamp === undefined) return undefined;
  return `~${Math.max(0, Math.ceil(Math.max(0, timestamp - now) / 1000))}s`;
}

export function formatBackgroundRunStatus(
  snapshot: BackgroundRunSnapshotLike,
  now = Date.now(),
): string {
  const nextCheck = formatRelativeDelay(snapshot.nextCheckAt, now);
  const nextHeartbeat = formatRelativeDelay(snapshot.nextHeartbeatAt, now);
  const lastVerified = formatRelativeAge(snapshot.lastVerifiedAt, now);
  const lines = [
    `Background run: ${snapshot.state}`,
    `Objective: ${snapshot.objective}`,
    `Cycles: ${snapshot.cycleCount}`,
  ];
  if (lastVerified) lines.push(`Last verified: ${lastVerified}`);
  if (snapshot.lastUserUpdate) lines.push(`Latest update: ${snapshot.lastUserUpdate}`);
  if (snapshot.pendingSignals > 0) lines.push(`Pending signals: ${snapshot.pendingSignals}`);
  if (nextHeartbeat) lines.push(`Next heartbeat: ${nextHeartbeat}`);
  if (nextCheck) lines.push(`Next check: ${nextCheck}`);
  if (!nextCheck && snapshot.state === "working") lines.push("Next check: pending");
  return lines.join("\n");
}

export function formatInactiveBackgroundRunStatus(
  snapshot: BackgroundRunRecentSnapshot | undefined,
  now = Date.now(),
): string {
  if (!snapshot) {
    return "No active background run for this session.";
  }
  const lastChanged = formatRelativeAge(snapshot.updatedAt, now);
  const lines = [
    "No active background run for this session.",
    `Last run: ${snapshot.state}`,
    `Objective: ${snapshot.objective}`,
  ];
  if (lastChanged) lines.push(`Last changed: ${lastChanged}`);
  if (snapshot.lastUserUpdate) lines.push(`Latest update: ${snapshot.lastUserUpdate}`);
  return lines.join("\n");
}

export function formatInactiveBackgroundRunStop(
  snapshot: BackgroundRunRecentSnapshot | undefined,
  now = Date.now(),
): string {
  if (!snapshot) {
    return "No active background run to stop.";
  }
  const lastChanged = formatRelativeAge(snapshot.updatedAt, now);
  const lines = [
    "No active background run to stop.",
    `Last run: ${snapshot.state}`,
    `Objective: ${snapshot.objective}`,
  ];
  if (lastChanged) lines.push(`Last changed: ${lastChanged}`);
  return lines.join("\n");
}

export function formatBackgroundRunAdmissionDenied(reason: string): string {
  const normalizedReason = reason.trim() || "Background-run admission was denied.";
  return [
    "Unable to start a durable background run for this session.",
    `Reason: ${normalizedReason}`,
    "The runtime did not fall back to a one-shot chat turn because you explicitly requested supervised background execution.",
    "Operator action: enable gateway autonomy/backgroundRuns for this runtime or retry with a normal one-shot request.",
  ].join("\n");
}
