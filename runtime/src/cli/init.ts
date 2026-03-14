import { resolve as resolvePath } from "node:path";
import { writeProjectGuide } from "../project-doc.js";
import type {
  CliRuntimeContext,
  CliStatusCode,
  InitOptions,
} from "./types.js";

export async function runInitCommand(
  context: CliRuntimeContext,
  options: InitOptions,
): Promise<CliStatusCode> {
  const projectRoot = resolvePath(options.path ?? process.cwd());

  try {
    const result = await writeProjectGuide(projectRoot, {
      force: options.force,
    });
    context.output({
      status: "ok",
      command: "init",
      projectRoot,
      filePath: result.filePath,
      result: result.status,
      force: options.force === true,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      command: "init",
      projectRoot,
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}
