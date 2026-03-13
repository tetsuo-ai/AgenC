import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeTool } from "./tools.js";
test("desktop bash honors explicit cwd", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agenc-desktop-bash-"));
    const nestedPath = join(workspacePath, "nested");
    try {
        await mkdir(nestedPath, { recursive: true });
        const result = await executeTool("bash", {
            command: "printf 'cwd-ok' > sample.txt",
            cwd: nestedPath,
        });
        assert.notEqual(result.isError, true);
        const written = await readFile(join(nestedPath, "sample.txt"), "utf8");
        assert.equal(written, "cwd-ok");
    }
    finally {
        await rm(workspacePath, { recursive: true, force: true });
    }
});
