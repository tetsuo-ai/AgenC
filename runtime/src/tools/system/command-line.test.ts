import { describe, expect, it } from "vitest";

import {
  parseDirectCommandLine,
  tokenizeShellCommand,
} from "./command-line.js";

describe("command-line", () => {
  it("tokenizes quoted arguments without shell operators", () => {
    expect(tokenizeShellCommand('git commit -m "hello world"')).toEqual([
      "git",
      "commit",
      "-m",
      "hello world",
    ]);
  });

  it("parses direct command lines into command plus args", () => {
    expect(parseDirectCommandLine('git status --short')).toEqual({
      command: "git",
      args: ["status", "--short"],
    });
  });

  it("rejects shell-style command lines", () => {
    expect(parseDirectCommandLine("git status --short | cat")).toBeUndefined();
    expect(parseDirectCommandLine("FOO=bar git status")).toBeUndefined();
  });
});
