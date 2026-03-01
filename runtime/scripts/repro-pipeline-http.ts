import { runPipelineHttpRepro } from "../src/eval/pipeline-http-repro.js";

async function main(): Promise<void> {
  const output = await runPipelineHttpRepro();
  console.log(JSON.stringify(output, null, 2));
  if (output.overall !== "pass") {
    process.exitCode = 1;
  }
}

void main();
