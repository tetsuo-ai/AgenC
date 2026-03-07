/**
 * Doom-specific intent detection and tool-evidence validation helpers.
 *
 * @module
 */

import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  didToolCallFail,
  parseToolResultObject,
} from "./chat-executor-tool-utils.js";

const DOOM_INTENT_RE =
  /\b(?:doom|vizdoom|defend_the_center|capture(?:\s+the)?\s+center)\b/i;
const DOOM_AUTONOMOUS_INTENT_RE =
  /\b(?:playing?\s+until\s+(?:you|i)\s+(?:say|tell)\s+(?:me\s+)?(?:to\s+)?stop|until\s+(?:you|i)\s+(?:say|tell)\s+(?:me\s+)?(?:to\s+)?stop|run(?:ning)?\s+(?:autonom(?:ous|ously)|async)|autoplay|continuous(?:ly)?(?:\s+playing)?|keep\s+playing|stay\s+running|async(?:\s+player)?|play\b|launch\b|start\b)\b/i;
const DOOM_HOLD_POSITION_INTENT_RE =
  /\b(?:hold(?:ing)?\s+position|stay(?:ing)?\s+(?:put|centered)|stationary|won't\s+run\s+around|will\s+not\s+run\s+around|don't\s+run\s+around|do\s+not\s+run\s+around|defend(?:ing)?(?:\s+|_)the(?:\s+|_)center|capture(?:\s+the)?\s+center)\b/i;
const DOOM_GOD_MODE_INTENT_RE =
  /\b(?:god mode|invulnerab(?:ility|le)|invincib(?:ility|le)|iddqd)\b/i;

export interface DoomTurnContract {
  readonly requiresLaunch: boolean;
  readonly requiresAutonomousPlay: boolean;
  readonly requiresHoldPosition: boolean;
  readonly requiresGodMode: boolean;
}

export interface DoomEvidenceState {
  readonly confirmedLaunch: boolean;
  readonly confirmedAsyncStart: boolean;
  readonly verifiedAsyncState: boolean;
  readonly confirmedHoldPosition: boolean;
  readonly confirmedGodMode: boolean;
  readonly executedTools: string[];
}

export interface DoomEvidenceGap {
  readonly code:
    | "missing_launch"
    | "missing_async_start"
    | "missing_god_mode"
    | "missing_hold_position"
    | "missing_async_verification";
  readonly message: string;
  readonly preferredToolNames: readonly string[];
}

export function inferDoomTurnContract(
  messageText: string,
): DoomTurnContract | undefined {
  if (!DOOM_INTENT_RE.test(messageText)) return undefined;

  const requiresAutonomousPlay = DOOM_AUTONOMOUS_INTENT_RE.test(messageText);
  const requiresHoldPosition = DOOM_HOLD_POSITION_INTENT_RE.test(messageText);
  const requiresGodMode = DOOM_GOD_MODE_INTENT_RE.test(messageText);
  const requiresLaunch =
    requiresAutonomousPlay || requiresHoldPosition || requiresGodMode;

  if (
    !requiresLaunch &&
    !requiresAutonomousPlay &&
    !requiresHoldPosition &&
    !requiresGodMode
  ) {
    return undefined;
  }

  return {
    requiresLaunch,
    requiresAutonomousPlay,
    requiresHoldPosition,
    requiresGodMode,
  };
}

export function summarizeDoomToolEvidence(
  toolCalls: readonly ToolCallRecord[],
): DoomEvidenceState {
  let confirmedLaunch = false;
  let confirmedAsyncStart = false;
  let verifiedAsyncState = false;
  let confirmedHoldPosition = false;
  let confirmedGodMode = false;

  for (const toolCall of toolCalls) {
    if (!toolCall.name.startsWith("mcp.doom.")) continue;
    if (didToolCallFail(toolCall.isError, toolCall.result)) continue;
    const resultObject = parseToolResultObject(toolCall.result);

    if (toolCall.name === "mcp.doom.start_game") {
      confirmedLaunch = true;
      if (toolCall.args?.async_player === true) {
        confirmedAsyncStart = true;
      }
      if (resultObject?.god_mode_enabled === true) {
        confirmedGodMode = true;
      }
      continue;
    }

    if (
      toolCall.name === "mcp.doom.get_situation_report" ||
      toolCall.name === "mcp.doom.get_state"
    ) {
      verifiedAsyncState = true;
      if (resultObject?.god_mode_enabled === true) {
        confirmedGodMode = true;
      }
      continue;
    }

    if (
      toolCall.name === "mcp.doom.set_objective" &&
      typeof toolCall.args?.objective_type === "string" &&
      toolCall.args.objective_type.trim().toLowerCase() === "hold_position"
    ) {
      confirmedHoldPosition = true;
      continue;
    }

    if (toolCall.name === "mcp.doom.set_god_mode") {
      const enabledArg =
        toolCall.args?.enabled === undefined || toolCall.args.enabled === true;
      if (
        enabledArg &&
        resultObject?.god_mode_enabled !== false
      ) {
        confirmedGodMode = true;
      }
    }
  }

  return {
    confirmedLaunch,
    confirmedAsyncStart,
    verifiedAsyncState,
    confirmedHoldPosition,
    confirmedGodMode,
    executedTools: collectExecutedToolNames(
      toolCalls.filter((toolCall) => toolCall.name.startsWith("mcp.doom.")),
    ),
  };
}

export function getMissingDoomEvidenceGap(
  contract: DoomTurnContract,
  evidence: DoomEvidenceState,
): DoomEvidenceGap | undefined {
  if (contract.requiresLaunch && !evidence.confirmedLaunch) {
    return {
      code: "missing_launch",
      message:
        "This Doom request is not complete yet. Launch Doom with `mcp.doom.start_game` before answering. " +
        "For play-until-stop requests, set `async_player: true` and preserve the requested scenario/window settings.",
      preferredToolNames: ["mcp.doom.start_game"],
    };
  }

  if (
    contract.requiresAutonomousPlay &&
    evidence.confirmedLaunch &&
    !evidence.confirmedAsyncStart
  ) {
    return {
      code: "missing_async_start",
      message:
        "Continuous Doom play was requested, but the game was not started in async mode. " +
        "Call `mcp.doom.start_game` again with `async_player: true` before answering.",
      preferredToolNames: ["mcp.doom.start_game"],
    };
  }

  if (contract.requiresGodMode && !evidence.confirmedGodMode) {
    return {
      code: "missing_god_mode",
      message:
        "God mode is still unverified. Call `mcp.doom.set_god_mode` with `enabled: true`, then verify with " +
        "`mcp.doom.get_state` or `mcp.doom.get_situation_report` before claiming invulnerability. " +
        "A `start_game` launch arg alone does not count as confirmation.",
      preferredToolNames: [
        "mcp.doom.set_god_mode",
        "mcp.doom.get_situation_report",
        "mcp.doom.get_state",
      ],
    };
  }

  if (contract.requiresHoldPosition && !evidence.confirmedHoldPosition) {
    return {
      code: "missing_hold_position",
      message:
        "Stationary center-defense is still incomplete. Call `mcp.doom.set_objective` with " +
        '`objective_type: "hold_position"` before answering.',
      preferredToolNames: ["mcp.doom.set_objective"],
    };
  }

  if (contract.requiresAutonomousPlay && !evidence.verifiedAsyncState) {
    return {
      code: "missing_async_verification",
      message:
        "Continuous autonomous play is still unverified. Call `mcp.doom.get_situation_report` or `mcp.doom.get_state` " +
        "and confirm the live executor state before answering.",
      preferredToolNames: [
        "mcp.doom.get_situation_report",
        "mcp.doom.get_state",
      ],
    };
  }

  return undefined;
}

function collectExecutedToolNames(
  toolCalls: readonly ToolCallRecord[],
): string[] {
  const executed = new Set<string>();
  for (const toolCall of toolCalls) {
    if (didToolCallFail(toolCall.isError, toolCall.result)) continue;
    executed.add(toolCall.name);
  }
  return [...executed];
}
