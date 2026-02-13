/**
 * Runtime event contract drift checker against generated IDL definitions.
 */

import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { RUNTIME_EVENT_CONTRACT, type EventContract, type EventFieldContract, type FieldFamily } from './idl-contract.js';
import idlJson from '../../idl/agenc_coordination.json';

interface IdlField {
  name: string;
  type: unknown;
}

interface IdlType {
  name: string;
  type?: {
    kind: string;
    fields?: IdlField[];
  };
}

interface IdlEvent {
  name: string;
}

interface IdlRoot {
  events?: IdlEvent[];
  types?: IdlType[];
}

export interface IdlDriftMismatch {
  path: string;
  line?: number;
  message: string;
}

export interface IdlDriftCheckResult {
  passed: boolean;
  mismatches: IdlDriftMismatch[];
}

export interface IdlDriftCheckerOptions {
  contract?: readonly EventContract[];
  idl?: IdlRoot;
  overrides?: ReadonlyArray<IdlDriftFieldOverride>;
}

export interface IdlDriftFieldOverride {
  eventName: string;
  fieldName: string;
  reason?: string;
}

const CONTRACT_FILE = resolve(process.cwd(), 'src/events/idl-contract.ts');
const CONTRACT_SOURCE_TEXT = readFile(CONTRACT_FILE, 'utf8');
const AGENT_EVENT_NAMES = new Set([
  'AgentDeregistered',
  'AgentRegistered',
  'AgentSuspended',
  'AgentUnsuspended',
  'AgentUpdated',
]);

function normalizeEventNameToPascalCase(eventName: string): string {
  if (!eventName) return eventName;
  return eventName[0].toUpperCase() + eventName.slice(1);
}

function normalizeFieldNameToCamelCase(fieldName: string): string {
  const parts = fieldName.split('_');
  return parts
    .map((value, index) => {
      if (!value) return value;
      if (index === 0) return value;
      return value[0].toUpperCase() + value.slice(1);
    })
    .join('');
}

function findEventTypeByName(idl: IdlRoot, eventName: string): IdlType | undefined {
  return idl.types?.find((entry) => entry.name === eventName && entry.type?.kind === 'struct');
}

function deriveFamily(rawType: unknown): FieldFamily | 'unknown' {
  if (typeof rawType === 'string') {
    if (rawType === 'pubkey') return 'pubkey';
    if (rawType === 'bool') return 'bool';
    if (rawType === 'i64') return 'i64';
    if (rawType === 'u8') return 'u8';
    if (rawType === 'u16') return 'u16';
    if (rawType === 'u32') return 'u32';
    if (rawType === 'u64') return 'u64';
    return 'unknown';
  }

  if (typeof rawType === 'object' && rawType !== null) {
    if ('array' in rawType && Array.isArray((rawType as { array: unknown }).array)) {
      const [baseType, size] = (rawType as { array: unknown[] }).array;
      if (baseType === 'u8' && Number.isInteger(size)) {
        if (size === 32) return 'bytes<32>';
        if (size === 64) return 'bytes<64>';
        return 'bytes<variable>';
      }
      return 'unknown';
    }

    if ('option' in rawType && typeof (rawType as { option: unknown }).option === 'string') {
      const inner = (rawType as { option: string }).option;
      if (inner === 'pubkey') return 'option<pubkey>';
      return `unknown`;
    }
  }

  return 'unknown';
}

function normalizeAndMatchField(raw: IdlField): EventFieldContract {
  return {
    name: normalizeFieldNameToCamelCase(raw.name),
    family: deriveFamily(raw.type),
  };
}

function getLineForContractContractField(eventName: string, fieldName: string, sourceText: string): number | undefined {
  const lines = sourceText.split('\n');
  const eventMarker = `eventName: '${eventName}',`;
  const fieldMarker = `name: '${fieldName}',`;
  const eventLine = lines.findIndex((line) => line.includes(eventMarker));
  if (eventLine < 0) return undefined;

  for (let i = eventLine + 1; i < lines.length; i++) {
    if (i > eventLine + 30) break;
    if (lines[i].includes(fieldMarker)) {
      return i + 1;
    }
  }

  // Fallback: point to event declaration line itself.
  return eventLine + 1;
}

function nonAgentEventNamesFromIdl(idl: IdlRoot): string[] {
  return (idl.events ?? []).map((event) => event.name).filter((name) => !AGENT_EVENT_NAMES.has(name));
}

/**
 * Dynamic fields that should be ignored intentionally during drift checks.
 * Kept as an explicit allowlist for schema evolution.
 */
export const IDL_DRIFT_FIELD_OVERRIDES = Object.freeze<ReadonlyArray<IdlDriftFieldOverride>>([]);

function isOverrideMatch(
  eventName: string,
  fieldName: string,
  overrides: ReadonlyArray<IdlDriftFieldOverride>,
): boolean {
  return IDL_DRIFT_FIELD_OVERRIDES.some(
    (override) => override.eventName === eventName && override.fieldName === fieldName,
  ) || overrides.some(
    (override) => override.eventName === eventName && override.fieldName === fieldName,
  );
}

/**
 * Runs deterministic contract checks against a provided IDL and event contract.
 */
export async function checkIdlDrift(options: IdlDriftCheckerOptions = {}): Promise<IdlDriftCheckResult> {
  const contract = options.contract ?? RUNTIME_EVENT_CONTRACT;
  const idl = options.idl ?? (idlJson as unknown as IdlRoot);
  const overrides = options.overrides ?? [];
  const sourceText = await CONTRACT_SOURCE_TEXT;
  const contractFileForOutput = relative(process.cwd(), CONTRACT_FILE);
  const idlEvents = nonAgentEventNamesFromIdl(idl);

  const idlEventSet = new Set(idlEvents);
  const contractEventSet = new Set(contract.map((event) => normalizeEventNameToPascalCase(event.eventName)));

  for (const contractEvent of contract) {
    const pascalEventName = normalizeEventNameToPascalCase(contractEvent.eventName);
    if (!idlEventSet.has(pascalEventName)) {
      return {
        passed: false,
        mismatches: [{
          path: contractFileForOutput,
          line: getLineForContractContractField(contractEvent.eventName, contractEvent.fields[0]?.name ?? '', sourceText),
          message: `IDL does not contain non-agent event "${pascalEventName}" required by runtime contract`,
        }],
      };
    }

    const idlType = findEventTypeByName(idl, pascalEventName);
    if (!idlType) {
      return {
        passed: false,
        mismatches: [{
          path: contractFileForOutput,
          line: getLineForContractContractField(contractEvent.eventName, contractEvent.fields[0]?.name ?? '', sourceText),
          message: `IDL struct type for event "${pascalEventName}" is missing`,
        }],
      };
    }

    const normalizedIdlFields = (idlType.type?.fields ?? []).map(normalizeAndMatchField);

    if (normalizedIdlFields.length !== contractEvent.fields.length) {
      return {
        passed: false,
        mismatches: [{
          path: contractFileForOutput,
          line: getLineForContractContractField(contractEvent.eventName, contractEvent.fields[0]?.name ?? '', sourceText),
          message: `Event "${contractEvent.eventName}" field count mismatch: contract=${contractEvent.fields.length}, idl=${normalizedIdlFields.length}`,
        }],
      };
    }

    for (let i = 0; i < contractEvent.fields.length; i++) {
      const contractField = contractEvent.fields[i];
      const idlField = normalizedIdlFields[i];
      if (!idlField || contractField.name !== idlField.name) {
        const line = getLineForContractContractField(contractEvent.eventName, contractField.name, sourceText);
        const idlFieldName = idlField?.name ?? '<missing>';
        return {
          passed: false,
          mismatches: [{
            path: contractFileForOutput,
            line,
            message: `Event ${contractEvent.eventName} field mismatch at position ${i}: contract name=${contractField.name}, idl name=${idlFieldName}`,
          }],
        };
      }
      if (
        !isOverrideMatch(contractEvent.eventName, contractField.name, overrides)
        && contractField.family !== idlField.family
      ) {
        const line = getLineForContractContractField(contractEvent.eventName, contractField.name, sourceText);
        return {
          passed: false,
          mismatches: [{
            path: contractFileForOutput,
            line,
            message: `Event ${contractEvent.eventName} field ${contractField.name} family mismatch: contract=${contractField.family}, idl=${idlField.family}`,
          }],
        };
      }
    }
  }

  for (const eventName of idlEvents) {
    if (!contractEventSet.has(eventName)) {
      return {
        passed: false,
        mismatches: [{
          path: contractFileForOutput,
          message: `Runtime contract is missing non-agent event "${eventName}" from IDL`,
        }],
      };
    }
  }

  return {
    passed: true,
    mismatches: [],
  };
}

export interface DriftCheckOutput {
  header: string;
  details: string[];
}

/**
 * Formats a deterministic mismatch report for CLI output.
 */
export function formatDriftCheckOutput(result: IdlDriftCheckResult): DriftCheckOutput {
  if (result.passed) {
    return {
      header: 'IDL contract drift check passed.',
      details: [],
    };
  }

  const lines = result.mismatches.map((item) => {
    const location = item.line ? `${item.path}:${item.line}` : item.path;
    return `${location} => ${item.message}`;
  });

  return {
    header: 'IDL contract drift check failed.',
    details: lines,
  };
}
