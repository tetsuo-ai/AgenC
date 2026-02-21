export interface SchemaChangeEntry {
  schema: string;
  version: string;
  date: string;
  changeType: "breaking" | "additive" | "deprecation";
  description: string;
  affectedFields: string[];
  migration?: string;
}

export const REPLAY_SCHEMA_CHANGELOG: SchemaChangeEntry[] = [
  {
    schema: "replay.backfill.output.v1",
    version: "0.1.0",
    date: "2026-02-01",
    changeType: "additive",
    description: "Initial schema release",
    affectedFields: ["*"],
  },
  {
    schema: "replay.compare.output.v1",
    version: "0.1.0",
    date: "2026-02-01",
    changeType: "additive",
    description: "Initial schema release",
    affectedFields: ["*"],
  },
  {
    schema: "replay.incident.output.v1",
    version: "0.1.0",
    date: "2026-02-01",
    changeType: "additive",
    description: "Initial schema release",
    affectedFields: ["*"],
  },
  {
    schema: "replay.status.output.v1",
    version: "0.1.0",
    date: "2026-02-01",
    changeType: "additive",
    description: "Initial schema release",
    affectedFields: ["*"],
  },
  {
    schema: "replay.backfill.output.v1",
    version: "0.1.1",
    date: "2026-02-14",
    changeType: "additive",
    description: "Added schema_hash field for drift detection",
    affectedFields: ["schema_hash"],
  },
  {
    schema: "replay.compare.output.v1",
    version: "0.1.1",
    date: "2026-02-14",
    changeType: "additive",
    description: "Added schema_hash field for drift detection",
    affectedFields: ["schema_hash"],
  },
  {
    schema: "replay.incident.output.v1",
    version: "0.1.1",
    date: "2026-02-14",
    changeType: "additive",
    description: "Added schema_hash field for drift detection",
    affectedFields: ["schema_hash"],
  },
  {
    schema: "replay.status.output.v1",
    version: "0.1.1",
    date: "2026-02-14",
    changeType: "additive",
    description: "Added schema_hash field for drift detection",
    affectedFields: ["schema_hash"],
  },
];

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    return left.localeCompare(right);
  }

  for (let i = 0; i < leftParsed.length; i += 1) {
    const delta = leftParsed[i] - rightParsed[i];
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

export function getSchemaChanges(
  schema: string,
  fromVersion?: string,
  toVersion?: string,
): SchemaChangeEntry[] {
  return REPLAY_SCHEMA_CHANGELOG.filter((entry) => {
    if (entry.schema !== schema) {
      return false;
    }
    if (fromVersion && compareVersions(entry.version, fromVersion) < 0) {
      return false;
    }
    if (toVersion && compareVersions(entry.version, toVersion) > 0) {
      return false;
    }
    return true;
  });
}

export function hasBreakingChanges(
  schema: string,
  fromVersion: string,
  toVersion: string,
): boolean {
  return getSchemaChanges(schema, fromVersion, toVersion).some(
    (entry) => entry.changeType === "breaking",
  );
}
