/**
 * Planner DAG state management and subagent plan step tracking for the watch TUI.
 *
 * Manages the directed acyclic graph of planner pipeline steps, subagent plan
 * steps, trace artifact hydration, and status/glyph helpers.
 */

import fs from "node:fs";
import path from "node:path";
import { sanitizeInlineText, truncate } from "./agenc-watch-text-utils.mjs";

// ─── Plan step & DAG status display helpers ─────────────────────────

export function planStatusTone(value) {
  switch (value) {
    case "completed":
      return "green";
    case "running":
      return "magenta";
    case "failed":
      return "red";
    case "cancelled":
      return "amber";
    case "blocked":
      return "amber";
    default:
      return "slate";
  }
}

export function planStatusGlyph(value) {
  switch (value) {
    case "completed":
      return "[x]";
    case "running":
      return "[~]";
    case "failed":
      return "[!]";
    case "cancelled":
      return "[-]";
    case "blocked":
      return "[?]";
    default:
      return "[ ]";
  }
}

export function sanitizePlanLabel(value, fallback = "unnamed task") {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    return fallback;
  }
  return text.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

export function plannerDagStatusTone(value) {
  switch (value) {
    case "completed":
      return "green";
    case "running":
      return "cyan";
    case "failed":
      return "red";
    case "cancelled":
      return "amber";
    case "blocked":
      return "amber";
    default:
      return "slate";
  }
}

export function plannerDagStatusGlyph(value) {
  switch (value) {
    case "completed":
      return "\u25cf";
    case "running":
      return "\u25c9";
    case "failed":
      return "\u2715";
    case "cancelled":
      return "\u25cc";
    case "blocked":
      return "\u25cd";
    default:
      return "\u25cb";
  }
}

export function plannerDagTypeGlyph(value) {
  switch (value) {
    case "subagent_task":
      return "A";
    case "deterministic_tool":
      return "T";
    case "synthesis":
      return "\u03a3";
    default:
      return "\u2022";
  }
}

export function planStepDisplayName(step, maxChars = 28) {
  const base = step?.stepName ||
    sanitizePlanLabel(step?.objective, step?.subagentSessionId || "child");
  return truncate(base, maxChars);
}

// ─── Planner DAG state operations ───────────────────────────────────

export function resetPlannerDagState(watchState, plannerDagNodes, plannerDagEdges) {
  plannerDagNodes.clear();
  plannerDagEdges.length = 0;
  watchState.plannerDagPipelineId = null;
  watchState.plannerDagStatus = "idle";
  watchState.plannerDagNote = null;
  watchState.plannerDagUpdatedAt = 0;
  watchState.plannerDagHydratedSessionId = null;
}

export function findTrackedPlannerDagKey(plannerDagNodes, input = {}) {
  const candidates = [
    sanitizeInlineText(input.stepName ?? input.name ?? ""),
    sanitizeInlineText(input.objective ?? ""),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (plannerDagNodes.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function ensurePlannerDagNode(watchState, plannerDagNodes, nowMs, input = {}) {
  const stepName = sanitizeInlineText(
    input.stepName ?? input.name ?? input.objective ?? "",
  );
  if (!stepName) {
    return null;
  }
  let node = plannerDagNodes.get(stepName);
  if (!node) {
    node = {
      key: stepName,
      stepName,
      objective: null,
      stepType: "subagent_task",
      status: "planned",
      note: null,
      order: Number.isFinite(Number(input.order))
        ? Number(input.order)
        : plannerDagNodes.size,
      tool: null,
      subagentSessionId: null,
    };
    plannerDagNodes.set(stepName, node);
  }
  if (typeof input.objective === "string" && input.objective.trim()) {
    node.objective = sanitizeInlineText(input.objective);
  }
  if (typeof input.stepType === "string" && input.stepType.trim()) {
    node.stepType = sanitizeInlineText(input.stepType);
  }
  if (typeof input.status === "string" && input.status.trim()) {
    node.status = sanitizeInlineText(input.status);
  }
  if (typeof input.note === "string" && input.note.trim()) {
    node.note = sanitizeInlineText(input.note);
  }
  if (typeof input.tool === "string" && input.tool.trim()) {
    node.tool = sanitizeInlineText(input.tool);
  }
  if (typeof input.subagentSessionId === "string" && input.subagentSessionId.trim()) {
    node.subagentSessionId = sanitizeInlineText(input.subagentSessionId);
  }
  if (Number.isFinite(Number(input.order))) {
    node.order = Number(input.order);
  }
  watchState.plannerDagUpdatedAt = nowMs();
  return node;
}

export function recomputePlannerDagStatus(watchState, plannerDagNodes) {
  const nodes = [...plannerDagNodes.values()];
  if (nodes.length === 0) {
    watchState.plannerDagStatus = "idle";
    return;
  }
  if (nodes.some((node) => node.status === "failed")) {
    watchState.plannerDagStatus = "failed";
    return;
  }
  if (nodes.some((node) => node.status === "blocked")) {
    watchState.plannerDagStatus = "blocked";
    return;
  }
  if (nodes.some((node) => node.status === "running")) {
    watchState.plannerDagStatus = "running";
    return;
  }
  if (nodes.every((node) => node.status === "completed")) {
    watchState.plannerDagStatus = "completed";
    return;
  }
  watchState.plannerDagStatus = "planned";
}

export function syncPlannerDagEdges(plannerDagEdges, steps = [], edges = [], options = {}) {
  const merge = options?.merge === true;
  const nextEdges = merge
    ? plannerDagEdges.map((edge) => ({ from: edge.from, to: edge.to }))
    : [];
  const seen = new Set(nextEdges.map((edge) => `${edge.from}->${edge.to}`));
  const pushEdge = (from, to) => {
    const left = sanitizeInlineText(from);
    const right = sanitizeInlineText(to);
    if (!left || !right || left === right) {
      return;
    }
    const fingerprint = `${left}->${right}`;
    if (seen.has(fingerprint)) {
      return;
    }
    seen.add(fingerprint);
    nextEdges.push({ from: left, to: right });
  };

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge || typeof edge !== "object") {
      continue;
    }
    pushEdge(edge.from, edge.to);
  }

  for (const step of Array.isArray(steps) ? steps : []) {
    const stepName = sanitizeInlineText(step?.name ?? "");
    if (!stepName || !Array.isArray(step?.dependsOn)) {
      continue;
    }
    for (const dependency of step.dependsOn) {
      pushEdge(dependency, stepName);
    }
  }

  plannerDagEdges.length = 0;
  plannerDagEdges.push(...nextEdges);
}

export function updatePlannerDagNode(watchState, plannerDagNodes, nowMs, input = {}) {
  const node = ensurePlannerDagNode(watchState, plannerDagNodes, nowMs, input);
  if (!node) {
    return null;
  }
  recomputePlannerDagStatus(watchState, plannerDagNodes);
  return node;
}

export function retirePlannerDagOpenNodes(watchState, plannerDagNodes, nowMs, status = "cancelled", note = null) {
  const nextStatus = sanitizeInlineText(status) || "cancelled";
  const nextNote = sanitizeInlineText(note ?? "");
  let changed = false;
  for (const node of plannerDagNodes.values()) {
    if (
      node.status !== "planned" &&
      node.status !== "running" &&
      node.status !== "blocked"
    ) {
      continue;
    }
    node.status = nextStatus;
    if (
      nextNote &&
      (
        !node.note ||
        node.note === sanitizeInlineText(node.stepName ?? "") ||
        node.note === sanitizeInlineText(node.objective ?? "") ||
        node.note === "planner refinement requested"
      )
    ) {
      node.note = nextNote;
    }
    changed = true;
  }
  if (changed) {
    watchState.plannerDagUpdatedAt = nowMs();
  }
}

export function inferMergedPlannerDagOrder(plannerDagNodes, stepName, payload = {}, fallbackOrder = 0) {
  const parents = Array.isArray(payload?.dependsOn)
    ? payload.dependsOn
      .map((dependency) => plannerDagNodes.get(sanitizeInlineText(dependency))?.order)
      .filter((value) => Number.isFinite(value))
    : [];
  if (parents.length > 0) {
    return Math.max(...parents) + 1;
  }

  const children = (Array.isArray(payload?.edges) ? payload.edges : [])
    .filter((edge) => sanitizeInlineText(edge?.from ?? "") === stepName)
    .map((edge) => plannerDagNodes.get(sanitizeInlineText(edge?.to ?? ""))?.order)
    .filter((value) => Number.isFinite(value));
  if (children.length > 0) {
    return Math.min(...children) - 1;
  }

  return fallbackOrder;
}

export function ingestPlannerDag(watchState, plannerDagNodes, plannerDagEdges, nowMs, payload = {}, options = {}) {
  const merge = options?.merge === true;
  if (!merge) {
    resetPlannerDagState(watchState, plannerDagNodes, plannerDagEdges);
  }
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  let nextMergedOrder = plannerDagNodes.size > 0
    ? Math.max(...[...plannerDagNodes.values()].map((node) => node.order)) + 10
    : 0;
  for (const [index, step] of steps.entries()) {
    const stepName = sanitizeInlineText(step?.name ?? "");
    const alreadyTracked = stepName ? plannerDagNodes.has(stepName) : false;
    let order = index * 10;
    if (merge && !alreadyTracked) {
      order = inferMergedPlannerDagOrder(plannerDagNodes, stepName, payload, nextMergedOrder);
      nextMergedOrder = Math.max(nextMergedOrder + 10, Math.ceil(order) + 10);
    }
    ensurePlannerDagNode(watchState, plannerDagNodes, nowMs, {
      stepName,
      objective: step?.objective,
      stepType: step?.stepType,
      status: "planned",
      note: step?.objective ?? step?.stepType ?? null,
      ...(merge && alreadyTracked ? {} : { order }),
    });
  }
  syncPlannerDagEdges(plannerDagEdges, steps, payload.edges, { merge });
  watchState.plannerDagPipelineId = sanitizeInlineText(payload.pipelineId ?? "");
  watchState.plannerDagNote = sanitizeInlineText(
    payload.routeReason ??
      payload.reason ??
      payload.stopReasonDetail ??
      payload.stopReason ??
      "",
  ) || null;
  recomputePlannerDagStatus(watchState, plannerDagNodes);
}

// ─── Trace artifact hydration ───────────────────────────────────────

function normalizeSessionValue(value) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    return null;
  }
  return text.replace(/^session:/, "");
}

export function plannerTraceSessionPrefix(sessionValue) {
  const normalized = normalizeSessionValue(sessionValue);
  if (!normalized) {
    return null;
  }
  return `session_${normalized.replace(/[^a-zA-Z0-9._-]+/g, "_")}_`;
}

export function listPlannerTraceArtifactsForSession(tracePayloadRoot, sessionValue) {
  const prefix = plannerTraceSessionPrefix(sessionValue);
  if (!prefix || !fs.existsSync(tracePayloadRoot)) {
    return [];
  }
  const artifacts = [];
  for (const entry of fs.readdirSync(tracePayloadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const directoryPath = path.join(tracePayloadRoot, entry.name);
    for (const fileName of fs.readdirSync(directoryPath)) {
      if (!fileName.includes("planner_plan_parsed") || !fileName.endsWith(".json")) {
        continue;
      }
      const artifactPath = path.join(directoryPath, fileName);
      let sortStamp = 0;
      const prefixMatch = fileName.match(/^(\d+)-/);
      if (prefixMatch) {
        sortStamp = Number(prefixMatch[1]) || 0;
      }
      if (!Number.isFinite(sortStamp) || sortStamp <= 0) {
        try {
          sortStamp = fs.statSync(artifactPath).mtimeMs;
        } catch {
          sortStamp = 0;
        }
      }
      artifacts.push({ artifactPath, sortStamp });
    }
  }
  artifacts.sort((left, right) => left.sortStamp - right.sortStamp);
  return artifacts.map((entry) => entry.artifactPath);
}

export function readPlannerTracePayload(artifactPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const payload =
      parsed?.payload?.payload &&
      typeof parsed.payload.payload === "object" &&
      !Array.isArray(parsed.payload.payload)
        ? parsed.payload.payload
        : parsed?.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
          ? parsed.payload
          : null;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function hydratePlannerDagFromTraceArtifacts(
  watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
  sessionValue, options = {},
) {
  const normalized = normalizeSessionValue(sessionValue);
  if (!normalized) {
    return false;
  }
  const force = options?.force === true;
  if (!force && watchState.plannerDagHydratedSessionId === normalized && plannerDagNodes.size > 1) {
    return false;
  }
  if (!force && plannerDagNodes.size > 1) {
    return false;
  }
  const artifacts = listPlannerTraceArtifactsForSession(tracePayloadRoot, sessionValue);
  if (artifacts.length === 0) {
    return false;
  }
  let hydrated = false;
  resetPlannerDagState(watchState, plannerDagNodes, plannerDagEdges);
  for (const [index, artifactPath] of artifacts.entries()) {
    const payload = readPlannerTracePayload(artifactPath);
    if (!payload) {
      continue;
    }
    const attempt = Number(payload.attempt);
    ingestPlannerDag(watchState, plannerDagNodes, plannerDagEdges, nowMs, payload, {
      merge: hydrated && Number.isFinite(attempt) ? attempt > 1 : index > 0,
    });
    hydrated = true;
  }
  if (hydrated) {
    watchState.plannerDagHydratedSessionId = normalized;
  }
  return hydrated;
}

export function hydratePlannerDagForLiveSession(
  watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
  options = {},
) {
  if (!watchState.sessionId) {
    return false;
  }
  const force = options?.force === true;
  if (!force && plannerDagNodes.size > 1) {
    return false;
  }
  return hydratePlannerDagFromTraceArtifacts(
    watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
    watchState.sessionId, { force },
  );
}

// ─── Subagent plan step tracking ────────────────────────────────────

export function ensureSubagentPlanStep(watchState, subagentPlanSteps, subagentSessionPlanKeys, nowMs, input = {}) {
  const stepName = sanitizeInlineText(input.stepName ?? "");
  const objective = sanitizeInlineText(input.objective ?? "");
  const sessionId = sanitizeInlineText(input.subagentSessionId ?? "");

  let key = null;
  if (sessionId && subagentSessionPlanKeys.has(sessionId)) {
    key = subagentSessionPlanKeys.get(sessionId);
  }
  if (!key && stepName) {
    key = `step:${stepName}`;
  }
  if (!key && sessionId) {
    key = `child:${sessionId}`;
  }
  if (!key && objective) {
    key = `objective:${objective}`;
  }
  if (!key) {
    return null;
  }

  let step = subagentPlanSteps.get(key);
  if (!step) {
    step = {
      key,
      order: ++watchState.planStepSequence,
      stepName: stepName || null,
      objective: objective || null,
      status: "planned",
      note: null,
      subagentSessionId: sessionId || null,
      updatedAt: nowMs(),
    };
    subagentPlanSteps.set(key, step);
  }

  if (stepName) {
    step.stepName = stepName;
  }
  if (objective) {
    step.objective = objective;
  }
  if (sessionId) {
    step.subagentSessionId = sessionId;
    subagentSessionPlanKeys.set(sessionId, key);
  }
  step.updatedAt = nowMs();
  return step;
}

export function updateSubagentPlanStep(
  watchState, plannerDagNodes, plannerDagEdges,
  subagentPlanSteps, subagentSessionPlanKeys, nowMs,
  input = {},
) {
  const step = ensureSubagentPlanStep(watchState, subagentPlanSteps, subagentSessionPlanKeys, nowMs, input);
  if (!step) {
    return null;
  }
  if (input.status) {
    step.status = input.status;
  }
  if (input.note) {
    step.note = sanitizeInlineText(input.note);
  }
  const dagKey = findTrackedPlannerDagKey(plannerDagNodes, {
    stepName: step.stepName,
    objective: step.objective,
  });
  const nodeKey = dagKey ?? step.stepName ?? planStepDisplayName(step);
  updatePlannerDagNode(watchState, plannerDagNodes, nowMs, {
    stepName: nodeKey,
    objective: step.objective,
    status: step.status,
    note: step.note,
    stepType: "subagent_task",
    subagentSessionId: step.subagentSessionId,
  });
  if (plannerDagNodes.size > 1 && watchState.currentObjective) {
    const rootKey = sanitizeInlineText(watchState.currentObjective);
    if (rootKey && rootKey !== nodeKey && plannerDagNodes.has(rootKey)) {
      syncPlannerDagEdges(plannerDagEdges, [], [{ from: rootKey, to: nodeKey }], { merge: true });
    }
  }
  return step;
}
