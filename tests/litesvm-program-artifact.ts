import * as fs from "fs";
import * as path from "path";

export function syncAgencProgramBinary(workspaceRoot: string): void {
  const workspaceBinaryPath = path.join(
    workspaceRoot,
    "target",
    "deploy",
    "agenc_coordination.so",
  );
  const programBinaryPath = path.join(
    workspaceRoot,
    "programs",
    "agenc-coordination",
    "target",
    "deploy",
    "agenc_coordination.so",
  );

  if (!fs.existsSync(programBinaryPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(workspaceBinaryPath), { recursive: true });

  let shouldCopy = !fs.existsSync(workspaceBinaryPath);
  if (!shouldCopy) {
    const workspaceStat = fs.statSync(workspaceBinaryPath);
    const programStat = fs.statSync(programBinaryPath);
    shouldCopy =
      workspaceStat.size !== programStat.size
      || programStat.mtimeMs > workspaceStat.mtimeMs;
  }

  if (shouldCopy) {
    fs.copyFileSync(programBinaryPath, workspaceBinaryPath);
  }
}
