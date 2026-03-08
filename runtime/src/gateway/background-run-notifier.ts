/**
 * BackgroundRunNotifier — fan-out delivery for durable run lifecycle updates.
 *
 * Keeps notification formatting and delivery separate from the supervisor so
 * runtime state transitions stay deterministic while sinks remain configurable.
 *
 * @module
 */

import { createHmac, randomUUID } from "node:crypto";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type {
  GatewayBackgroundRunNotificationConfig,
  GatewayBackgroundRunNotificationEvent,
  GatewayBackgroundRunNotificationSink,
} from "./types.js";
import type { BackgroundRunOperatorSummary } from "./background-run-operator.js";
import type { BackgroundRunEventType } from "./background-run-store.js";

export interface BackgroundRunNotificationDelivery {
  readonly sinkId: string;
  readonly eventId: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

export interface BackgroundRunNotificationContext {
  readonly occurredAt: number;
  readonly internalEventType: BackgroundRunEventType;
  readonly summary: string;
  readonly run: BackgroundRunOperatorSummary;
}

type FetchLike = typeof fetch;

const DEFAULT_NOTIFICATION_EVENTS: readonly GatewayBackgroundRunNotificationEvent[] = [
  "run_started",
  "run_updated",
  "run_blocked",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_controlled",
];

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function mapInternalEventType(
  eventType: BackgroundRunEventType,
): GatewayBackgroundRunNotificationEvent | undefined {
  switch (eventType) {
    case "run_started":
      return "run_started";
    case "run_blocked":
      return "run_blocked";
    case "run_completed":
      return "run_completed";
    case "run_failed":
      return "run_failed";
    case "run_cancelled":
      return "run_cancelled";
    case "run_paused":
    case "run_resumed":
    case "run_objective_updated":
    case "run_contract_amended":
    case "run_budget_adjusted":
    case "run_compaction_forced":
    case "run_worker_reassigned":
    case "run_retried":
    case "run_verification_overridden":
      return "run_controlled";
    case "run_recovered":
    case "run_signalled":
    case "run_suspended":
    case "cycle_started":
    case "cycle_working":
    case "decision":
    case "memory_compacted":
    case "subrun_spawned":
    case "subrun_joined":
    case "user_update":
      return "run_updated";
    case "subrun_failed_attribution":
      return "run_failed";
  }
}

function shouldDeliverToSink(
  sink: GatewayBackgroundRunNotificationSink,
  eventType: GatewayBackgroundRunNotificationEvent,
  sessionId: string,
): boolean {
  if (sink.enabled === false) {
    return false;
  }
  if (sink.sessionIds && sink.sessionIds.length > 0 && !sink.sessionIds.includes(sessionId)) {
    return false;
  }
  const events = sink.events && sink.events.length > 0
    ? sink.events
    : DEFAULT_NOTIFICATION_EVENTS;
  return events.includes(eventType);
}

function buildSharedPayload(params: {
  eventId: string;
  eventType: GatewayBackgroundRunNotificationEvent;
  context: BackgroundRunNotificationContext;
}) {
  const { eventId, eventType, context } = params;
  return {
    id: eventId,
    eventType,
    occurredAt: context.occurredAt,
    summary: truncate(context.summary, 500),
    internalEventType: context.internalEventType,
    run: {
      runId: context.run.runId,
      sessionId: context.run.sessionId,
      objective: context.run.objective,
      state: context.run.state,
      currentPhase: context.run.currentPhase,
      explanation: context.run.explanation,
      unsafeToContinue: context.run.unsafeToContinue,
      cycleCount: context.run.cycleCount,
      contractKind: context.run.contractKind,
      contractDomain: context.run.contractDomain,
      pendingSignals: context.run.pendingSignals,
      checkpointAvailable: context.run.checkpointAvailable,
      updatedAt: context.run.updatedAt,
      lastVerifiedAt: context.run.lastVerifiedAt,
      lastUserUpdate: context.run.lastUserUpdate,
      lastWakeReason: context.run.lastWakeReason,
      approvalRequired: context.run.approvalRequired,
      approvalState: context.run.approvalState,
      preferredWorkerId: context.run.preferredWorkerId,
      workerAffinityKey: context.run.workerAffinityKey,
    },
  };
}

function buildTextSummary(params: {
  eventType: GatewayBackgroundRunNotificationEvent;
  context: BackgroundRunNotificationContext;
}): string {
  const { context, eventType } = params;
  return [
    `[${eventType}] ${context.run.objective}`,
    `state=${context.run.state}`,
    `phase=${context.run.currentPhase}`,
    `summary=${truncate(context.summary, 240)}`,
    `run=${context.run.runId}`,
    `session=${context.run.sessionId}`,
  ].join(" | ");
}

function signPayload(secret: string, body: string, timestamp: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(timestamp);
  mac.update(".");
  mac.update(body);
  return `sha256=${mac.digest("hex")}`;
}

export class BackgroundRunNotifier {
  private readonly config: GatewayBackgroundRunNotificationConfig;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;

  constructor(params: {
    config: GatewayBackgroundRunNotificationConfig;
    fetchImpl?: FetchLike;
    logger?: Logger;
  }) {
    this.config = params.config;
    this.fetchImpl = params.fetchImpl ?? fetch;
    this.logger = params.logger ?? silentLogger;
  }

  isEnabled(): boolean {
    return this.config.enabled !== false &&
      Array.isArray(this.config.sinks) &&
      this.config.sinks.length > 0;
  }

  async notify(
    context: BackgroundRunNotificationContext,
  ): Promise<readonly BackgroundRunNotificationDelivery[]> {
    const eventType = mapInternalEventType(context.internalEventType);
    if (!eventType || !this.isEnabled()) {
      return [];
    }

    const deliveries = await Promise.all(
      (this.config.sinks ?? [])
        .filter((sink) => shouldDeliverToSink(sink, eventType, context.run.sessionId))
        .map((sink) => this.deliverToSink(sink, eventType, context)),
    );
    return deliveries;
  }

  private async deliverToSink(
    sink: GatewayBackgroundRunNotificationSink,
    eventType: GatewayBackgroundRunNotificationEvent,
    context: BackgroundRunNotificationContext,
  ): Promise<BackgroundRunNotificationDelivery> {
    const eventId = randomUUID();
    const timestamp = String(context.occurredAt);
    const sharedPayload = buildSharedPayload({ eventId, eventType, context });
    const body = this.buildSinkBody(sink, eventType, context, sharedPayload);
    const json = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agenc-event-id": eventId,
      "x-agenc-event-type": eventType,
      "x-agenc-event-timestamp": timestamp,
      ...(sink.headers ?? {}),
    };
    if (sink.signingSecret) {
      headers["x-agenc-signature"] = signPayload(
        sink.signingSecret,
        json,
        timestamp,
      );
    }

    try {
      const response = await this.fetchImpl(sink.url, {
        method: "POST",
        headers,
        body: json,
      });
      if (!response.ok) {
        const error = `Notification sink "${sink.id}" returned HTTP ${response.status}`;
        this.logger.warn(error, {
          sinkId: sink.id,
          eventType,
          sessionId: context.run.sessionId,
          runId: context.run.runId,
        });
        return {
          sinkId: sink.id,
          eventId,
          ok: false,
          status: response.status,
          error,
        };
      }
      return {
        sinkId: sink.id,
        eventId,
        ok: true,
        status: response.status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Background run notification delivery failed", {
        sinkId: sink.id,
        eventType,
        sessionId: context.run.sessionId,
        runId: context.run.runId,
        error: message,
      });
      return {
        sinkId: sink.id,
        eventId,
        ok: false,
        error: message,
      };
    }
  }

  private buildSinkBody(
    sink: GatewayBackgroundRunNotificationSink,
    eventType: GatewayBackgroundRunNotificationEvent,
    context: BackgroundRunNotificationContext,
    sharedPayload: ReturnType<typeof buildSharedPayload>,
  ): Record<string, unknown> {
    const text = buildTextSummary({ eventType, context });
    switch (sink.type) {
      case "slack_webhook":
        return {
          text,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${eventType}*\n${text}`,
              },
            },
          ],
          metadata: sharedPayload,
        };
      case "discord_webhook":
        return {
          content: text,
          embeds: [
            {
              title: context.run.objective,
              description: truncate(context.summary, 400),
              timestamp: new Date(context.occurredAt).toISOString(),
            },
          ],
          metadata: sharedPayload,
        };
      case "email_webhook":
        return {
          to: sink.recipient,
          subject: `[AgenC] ${eventType} :: ${truncate(context.run.objective, 96)}`,
          text,
          metadata: sharedPayload,
        };
      case "mobile_push_webhook":
        return {
          recipient: sink.recipient,
          title: `AgenC ${eventType}`,
          body: truncate(text, 180),
          metadata: sharedPayload,
        };
      case "webhook":
      default:
        return sharedPayload;
    }
  }
}
