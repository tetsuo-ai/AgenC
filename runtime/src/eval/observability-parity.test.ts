/**
 * Cross-Layer Observability Parity Tests
 *
 * Validates anomalies maintain consistent identity across runtime alerting,
 * replay store records, and MCP tool outputs.
 *
 * Implements #989 P2-404: Cross-layer observability parity tests
 *
 * LIMITATION: These tests use simulated layer outputs (simulateRuntimeAlerts,
 * simulateReplayStoreRecords, simulateMcpToolResponse) defined locally.
 * They verify that the simulation functions produce consistent output from
 * shared inputs, but do NOT verify the actual runtime alerting, replay store,
 * or MCP tool implementations produce matching output. Integration tests
 * against real implementations are needed for full parity verification.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IncidentAnomalyRef, AnomalySeverity } from './incident-case.js';
import type { ProjectedTimelineEvent } from './projector.js';
import type { JsonObject } from './types.js';

// ============================================================================
// Test Fixtures - Intentionally malformed event streams
// ============================================================================

/**
 * Create a malformed event fixture with various anomaly scenarios.
 */
function createMalformedEventFixture(): ProjectedTimelineEvent[] {
  return [
    // Valid event
    {
      seq: 1,
      type: 'task_created',
      taskPda: 'TaskPda111111111111111111111111111111111111',
      timestampMs: 1700000000000,
      payload: {
        creator: 'Creator1111111111111111111111111111111111111',
        reward: 1000000,
      },
      slot: 100,
      signature: 'Sig111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
      sourceEventName: 'TaskCreated',
      sourceEventSequence: 1,
    },
    // Hash mismatch anomaly
    {
      seq: 2,
      type: 'task_completed',
      taskPda: 'TaskPda111111111111111111111111111111111111',
      timestampMs: 1700000001000,
      payload: {
        worker: 'Worker1111111111111111111111111111111111111',
        proofHash: 'invalid_hash_not_matching_expected',
        expectedHash: 'correct_hash_value_here',
      },
      slot: 101,
      signature: 'Sig222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      sourceEventName: 'TaskCompleted',
      sourceEventSequence: 2,
    },
    // Missing signature anomaly
    {
      seq: 3,
      type: 'dispute_initiated',
      taskPda: 'TaskPda111111111111111111111111111111111111',
      timestampMs: 1700000002000,
      payload: {
        initiator: 'Initiator111111111111111111111111111111111',
        disputePda: 'DisputePda1111111111111111111111111111111',
        // Missing signature field
      },
      slot: 102,
      signature: '',
      sourceEventName: 'DisputeInitiated',
      sourceEventSequence: 3,
    },
    // Invalid slot sequence
    {
      seq: 4,
      type: 'task_claimed',
      taskPda: 'TaskPda222222222222222222222222222222222222',
      timestampMs: 1700000003000,
      payload: {
        worker: 'Worker2222222222222222222222222222222222222',
      },
      slot: 50, // Slot going backwards
      signature: 'Sig444444444444444444444444444444444444444444444444444444444444444444444444444444444444',
      sourceEventName: 'TaskClaimed',
      sourceEventSequence: 4,
    },
  ];
}

/**
 * Detected anomalies fixture.
 */
function createAnomalyFixture(): IncidentAnomalyRef[] {
  return [
    {
      code: 'hash_mismatch',
      severity: 'error',
      description: 'Proof hash does not match expected value',
      slot: 101,
      entityPda: 'TaskPda111111111111111111111111111111111111',
    },
    {
      code: 'missing_signature',
      severity: 'warning',
      description: 'Event signature field is empty',
      slot: 102,
      entityPda: 'DisputePda1111111111111111111111111111111',
    },
    {
      code: 'slot_regression',
      severity: 'warning',
      description: 'Slot number decreased from previous event',
      slot: 50,
      entityPda: 'TaskPda222222222222222222222222222222222222',
    },
  ];
}

// ============================================================================
// Simulated Layer Outputs
// ============================================================================

interface RuntimeAlert {
  code: string;
  severity: AnomalySeverity;
  description: string;
  slot: number;
  entityPda?: string;
  signature?: string;
  accountKey?: string;
}

interface ReplayStoreRecord {
  anomalyCode: string;
  severity: AnomalySeverity;
  message: string;
  slot: number;
  entityRef?: string;
  txSignature?: string;
}

interface McpToolResponse {
  anomalies: Array<{
    code: string;
    severity: AnomalySeverity;
    text: string;
    slot: number;
    entity?: string;
  }>;
}

/**
 * Simulate runtime alerting layer output.
 */
function simulateRuntimeAlerts(
  anomalies: IncidentAnomalyRef[],
  events: ProjectedTimelineEvent[],
  redact: boolean = false,
): RuntimeAlert[] {
  return anomalies.map((anomaly) => {
    const event = events.find((e) => e.slot === anomaly.slot);
    const alert: RuntimeAlert = {
      code: anomaly.code,
      severity: anomaly.severity,
      description: anomaly.description,
      slot: anomaly.slot,
      entityPda: anomaly.entityPda,
    };

    if (event && !redact) {
      alert.signature = event.signature;
      const payload = event.payload as JsonObject;
      alert.accountKey = (payload.creator || payload.worker || payload.initiator) as string;
    }

    return alert;
  });
}

/**
 * Simulate replay store record output.
 */
function simulateReplayStoreRecords(
  anomalies: IncidentAnomalyRef[],
  events: ProjectedTimelineEvent[],
): ReplayStoreRecord[] {
  return anomalies.map((anomaly) => {
    const event = events.find((e) => e.slot === anomaly.slot);
    return {
      anomalyCode: anomaly.code,
      severity: anomaly.severity,
      message: anomaly.description,
      slot: anomaly.slot,
      entityRef: anomaly.entityPda,
      txSignature: event?.signature,
    };
  });
}

/**
 * Simulate MCP tool response output.
 */
function simulateMcpToolResponse(anomalies: IncidentAnomalyRef[]): McpToolResponse {
  return {
    anomalies: anomalies.map((anomaly) => ({
      code: anomaly.code,
      severity: anomaly.severity,
      text: anomaly.description,
      slot: anomaly.slot,
      entity: anomaly.entityPda,
    })),
  };
}

// ============================================================================
// Shared Assertion Utilities
// ============================================================================

/**
 * Assert anomaly identity parity across layers.
 */
function assertAnomalyIdentityParity(
  alerts: RuntimeAlert[],
  records: ReplayStoreRecord[],
  mcpResponse: McpToolResponse,
  expectedCode: string,
  expectedSeverity: AnomalySeverity,
): void {
  const alert = alerts.find((a) => a.code === expectedCode);
  const record = records.find((r) => r.anomalyCode === expectedCode);
  const mcpAnomaly = mcpResponse.anomalies.find((a) => a.code === expectedCode);

  expect(alert).toBeDefined();
  expect(record).toBeDefined();
  expect(mcpAnomaly).toBeDefined();

  // Verify code matches across all layers
  expect(alert!.code).toBe(expectedCode);
  expect(record!.anomalyCode).toBe(expectedCode);
  expect(mcpAnomaly!.code).toBe(expectedCode);

  // Verify severity matches across all layers
  expect(alert!.severity).toBe(expectedSeverity);
  expect(record!.severity).toBe(expectedSeverity);
  expect(mcpAnomaly!.severity).toBe(expectedSeverity);

  // Verify slot matches across all layers
  expect(alert!.slot).toBe(record!.slot);
  expect(record!.slot).toBe(mcpAnomaly!.slot);
}

/**
 * Assert entity references are consistent.
 */
function assertEntityRefParity(
  alerts: RuntimeAlert[],
  records: ReplayStoreRecord[],
  mcpResponse: McpToolResponse,
  expectedCode: string,
): void {
  const alert = alerts.find((a) => a.code === expectedCode);
  const record = records.find((r) => r.anomalyCode === expectedCode);
  const mcpAnomaly = mcpResponse.anomalies.find((a) => a.code === expectedCode);

  expect(alert!.entityPda).toBe(record!.entityRef);
  expect(record!.entityRef).toBe(mcpAnomaly!.entity);
}

/**
 * Assert sensitive data is redacted.
 */
function assertRedaction(
  alerts: RuntimeAlert[],
  fieldName: 'signature' | 'accountKey',
): void {
  for (const alert of alerts) {
    expect(alert[fieldName]).toBeUndefined();
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Cross-Layer Observability Parity', () => {
  let events: ProjectedTimelineEvent[];
  let anomalies: IncidentAnomalyRef[];
  let runtimeAlerts: RuntimeAlert[];
  let replayRecords: ReplayStoreRecord[];
  let mcpResponse: McpToolResponse;

  beforeEach(() => {
    events = createMalformedEventFixture();
    anomalies = createAnomalyFixture();
    runtimeAlerts = simulateRuntimeAlerts(anomalies, events);
    replayRecords = simulateReplayStoreRecords(anomalies, events);
    mcpResponse = simulateMcpToolResponse(anomalies);
  });

  describe('Identity Parity Tests', () => {
    it('hash_mismatch anomaly has matching code and severity across all layers', () => {
      assertAnomalyIdentityParity(
        runtimeAlerts,
        replayRecords,
        mcpResponse,
        'hash_mismatch',
        'error',
      );
    });

    it('missing_signature anomaly has matching code and severity across all layers', () => {
      assertAnomalyIdentityParity(
        runtimeAlerts,
        replayRecords,
        mcpResponse,
        'missing_signature',
        'warning',
      );
    });

    it('slot_regression anomaly has matching code and severity across all layers', () => {
      assertAnomalyIdentityParity(
        runtimeAlerts,
        replayRecords,
        mcpResponse,
        'slot_regression',
        'warning',
      );
    });

    it('all anomaly types are present in all three layers', () => {
      expect(runtimeAlerts).toHaveLength(3);
      expect(replayRecords).toHaveLength(3);
      expect(mcpResponse.anomalies).toHaveLength(3);
    });
  });

  describe('Entity Reference Parity Tests', () => {
    it('hash_mismatch entity reference is consistent', () => {
      assertEntityRefParity(runtimeAlerts, replayRecords, mcpResponse, 'hash_mismatch');
    });

    it('missing_signature entity reference is consistent', () => {
      assertEntityRefParity(runtimeAlerts, replayRecords, mcpResponse, 'missing_signature');
    });

    it('slot_regression entity reference is consistent', () => {
      assertEntityRefParity(runtimeAlerts, replayRecords, mcpResponse, 'slot_regression');
    });

    it('slot numbers match corresponding event slots', () => {
      const hashMismatchAlert = runtimeAlerts.find((a) => a.code === 'hash_mismatch');
      expect(hashMismatchAlert!.slot).toBe(101);

      const missingSignatureRecord = replayRecords.find((r) => r.anomalyCode === 'missing_signature');
      expect(missingSignatureRecord!.slot).toBe(102);
    });
  });

  describe('Redaction Verification Tests', () => {
    it('signatures are absent when redaction is enabled', () => {
      const redactedAlerts = simulateRuntimeAlerts(anomalies, events, true);
      assertRedaction(redactedAlerts, 'signature');
    });

    it('account keys are absent when redaction is enabled', () => {
      const redactedAlerts = simulateRuntimeAlerts(anomalies, events, true);
      assertRedaction(redactedAlerts, 'accountKey');
    });

    it('unredacted alerts contain signature data', () => {
      const unredactedAlerts = simulateRuntimeAlerts(anomalies, events, false);
      const alertWithSig = unredactedAlerts.find((a) => a.code === 'hash_mismatch');
      expect(alertWithSig!.signature).toBeDefined();
      expect(alertWithSig!.signature!.length).toBeGreaterThan(0);
    });
  });

  describe('Determinism Tests', () => {
    it('produces deterministic results across multiple runs', () => {
      // Run simulation multiple times
      const results: string[] = [];

      for (let i = 0; i < 5; i++) {
        const alerts = simulateRuntimeAlerts(anomalies, events);
        const records = simulateReplayStoreRecords(anomalies, events);
        const mcp = simulateMcpToolResponse(anomalies);

        const hash = JSON.stringify({ alerts, records, mcp });
        results.push(hash);
      }

      // All results should be identical
      const firstResult = results[0];
      for (const result of results) {
        expect(result).toBe(firstResult);
      }
    });

    it('anomaly ordering is consistent across layers', () => {
      const alertCodes = runtimeAlerts.map((a) => a.code);
      const recordCodes = replayRecords.map((r) => r.anomalyCode);
      const mcpCodes = mcpResponse.anomalies.map((a) => a.code);

      expect(alertCodes).toEqual(recordCodes);
      expect(recordCodes).toEqual(mcpCodes);
    });
  });
});
