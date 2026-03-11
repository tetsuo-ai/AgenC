import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const NPM_WORKSPACE_PROTOCOL_RE =
  /unsupported url type\s+"workspace:"|eunsupportedprotocol/i;

export type HostWorkspaceProtocolSupport = "supported" | "unsupported" | "unknown";

export interface HostNpmToolingProfile {
  readonly version: string;
  readonly workspaceProtocolSupport: HostWorkspaceProtocolSupport;
  readonly workspaceProtocolEvidence?: string;
}

export interface HostToolingProfile {
  readonly nodeVersion: string;
  readonly npm?: HostNpmToolingProfile;
}

interface CommandExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface HostToolingProbeOptions {
  readonly runCommand?: (params: {
    command: string;
    args: readonly string[];
    cwd?: string;
    timeoutMs?: number;
  }) => Promise<CommandExecutionResult>;
  readonly timeoutMs?: number;
  readonly tmpRoot?: string;
}

async function defaultRunCommand(params: {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<CommandExecutionResult> {
  try {
    const { stdout, stderr } = await execFileAsync(params.command, [...params.args], {
      cwd: params.cwd,
      timeout: params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxBuffer: 1_048_576,
    });
    return {
      stdout: String(stdout),
      stderr: String(stderr),
      exitCode: 0,
    };
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      message?: string;
    };
    return {
      stdout:
        typeof err.stdout === "string"
          ? err.stdout
          : Buffer.isBuffer(err.stdout)
            ? err.stdout.toString("utf-8")
            : "",
      stderr:
        typeof err.stderr === "string"
          ? err.stderr
          : Buffer.isBuffer(err.stderr)
            ? err.stderr.toString("utf-8")
            : (err.message ?? ""),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

function summarizeProbeEvidence(text: string): string | undefined {
  const normalized = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return normalized?.slice(0, 240);
}

async function probeNpmWorkspaceProtocol(params: {
  runCommand: NonNullable<HostToolingProbeOptions["runCommand"]>;
  timeoutMs: number;
  tmpRoot: string;
}): Promise<{
  workspaceProtocolSupport: HostWorkspaceProtocolSupport;
  workspaceProtocolEvidence?: string;
}> {
  const probeRoot = await mkdtemp(join(params.tmpRoot, "agenc-npm-workspace-"));
  try {
    await mkdir(join(probeRoot, "packages", "core"), { recursive: true });
    await mkdir(join(probeRoot, "packages", "cli"), { recursive: true });
    await writeFile(
      join(probeRoot, "package.json"),
      JSON.stringify(
        {
          name: "agenc-host-tooling-probe",
          private: true,
          workspaces: ["packages/*"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    await writeFile(
      join(probeRoot, "packages", "core", "package.json"),
      JSON.stringify(
        {
          name: "@agenc-probe/core",
          version: "1.0.0",
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    await writeFile(
      join(probeRoot, "packages", "cli", "package.json"),
      JSON.stringify(
        {
          name: "@agenc-probe/cli",
          version: "1.0.0",
          dependencies: {
            "@agenc-probe/core": "workspace:*",
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const installResult = await params.runCommand({
      command: "npm",
      args: [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      cwd: probeRoot,
      timeoutMs: params.timeoutMs,
    });
    const combinedOutput = `${installResult.stderr}\n${installResult.stdout}`.trim();
    if (installResult.exitCode === 0) {
      return { workspaceProtocolSupport: "supported" };
    }
    if (NPM_WORKSPACE_PROTOCOL_RE.test(combinedOutput)) {
      return {
        workspaceProtocolSupport: "unsupported",
        workspaceProtocolEvidence: summarizeProbeEvidence(combinedOutput),
      };
    }
    return {
      workspaceProtocolSupport: "unknown",
      workspaceProtocolEvidence: summarizeProbeEvidence(combinedOutput),
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function probeHostToolingProfile(
  options: HostToolingProbeOptions = {},
): Promise<HostToolingProfile> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const profile: HostToolingProfile = {
    nodeVersion: process.version,
  };

  const npmVersion = await runCommand({
    command: "npm",
    args: ["--version"],
    timeoutMs,
  });
  const version = npmVersion.stdout.trim();
  if (npmVersion.exitCode !== 0 || version.length === 0) {
    return profile;
  }

  const workspaceProbe = await probeNpmWorkspaceProtocol({
    runCommand,
    timeoutMs,
    tmpRoot: options.tmpRoot ?? tmpdir(),
  });
  return {
    ...profile,
    npm: {
      version,
      workspaceProtocolSupport: workspaceProbe.workspaceProtocolSupport,
      ...(workspaceProbe.workspaceProtocolEvidence
        ? { workspaceProtocolEvidence: workspaceProbe.workspaceProtocolEvidence }
        : {}),
    },
  };
}
