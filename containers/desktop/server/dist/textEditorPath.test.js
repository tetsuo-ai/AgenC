import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeTool } from "./tools.js";
import { resolveValidatedTextEditorPath } from "./textEditorPath.js";
async function withWorkspace(fn) {
    const workspacePath = await mkdtemp(join(tmpdir(), "agenc-text-editor-"));
    try {
        await fn(workspacePath);
    }
    finally {
        await rm(workspacePath, { recursive: true, force: true });
    }
}
test("resolveValidatedTextEditorPath allows relative paths within the allowed root", async () => {
    await withWorkspace(async (workspacePath) => {
        const allowedRoot = join(workspacePath, "allowed");
        await mkdir(join(allowedRoot, "nested"), { recursive: true });
        const canonicalAllowedRoot = await realpath(allowedRoot);
        const resolvedPath = await resolveValidatedTextEditorPath("nested/file.txt", {
            allowedRoots: [allowedRoot],
            baseDir: allowedRoot,
        });
        assert.equal(resolvedPath, join(canonicalAllowedRoot, "nested", "file.txt"));
    });
});
test("resolveValidatedTextEditorPath rejects prefix-confusion siblings", async () => {
    await withWorkspace(async (workspacePath) => {
        const allowedRoot = join(workspacePath, "allowed");
        await mkdir(allowedRoot, { recursive: true });
        await assert.rejects(() => resolveValidatedTextEditorPath(join(`${allowedRoot}2`, "blocked.txt"), {
            allowedRoots: [allowedRoot],
            baseDir: allowedRoot,
        }), /Access denied/);
    });
});
test("resolveValidatedTextEditorPath rejects traversal outside the allowed root", async () => {
    await withWorkspace(async (workspacePath) => {
        const allowedRoot = join(workspacePath, "allowed");
        await mkdir(allowedRoot, { recursive: true });
        await assert.rejects(() => resolveValidatedTextEditorPath(join(allowedRoot, "..", "outside", "blocked.txt"), {
            allowedRoots: [allowedRoot],
            baseDir: allowedRoot,
        }), /Access denied/);
    });
});
test("resolveValidatedTextEditorPath rejects symlink escapes", async () => {
    await withWorkspace(async (workspacePath) => {
        const allowedRoot = join(workspacePath, "allowed");
        const outsideRoot = join(workspacePath, "outside");
        const linkPath = join(allowedRoot, "link");
        await mkdir(allowedRoot, { recursive: true });
        await mkdir(outsideRoot, { recursive: true });
        await symlink(outsideRoot, linkPath);
        await assert.rejects(() => resolveValidatedTextEditorPath(join(linkPath, "blocked.txt"), {
            allowedRoots: [allowedRoot],
            baseDir: allowedRoot,
        }), /Access denied/);
    });
});
test("text_editor rejects prefix confusion at the tool entrypoint", async () => {
    const result = await executeTool("text_editor", {
        command: "view",
        path: "/tmp2/blocked.txt",
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /Access denied/);
});
