import { describe, expect, it } from "vitest";
import { deriveCuriosityInterestsFromWorkspaceFiles } from "./curiosity-interests.js";

describe("deriveCuriosityInterestsFromWorkspaceFiles", () => {
  it("extracts explicit bullet-list interests from workspace files", () => {
    const interests = deriveCuriosityInterestsFromWorkspaceFiles({
      user: [
        "# User Preferences",
        "",
        "## Interests",
        "- TypeScript tooling",
        "- Local agent autonomy",
        "",
        "## Other",
        "- Ignore me",
      ].join("\n"),
      agent: undefined,
      identity: undefined,
      soul: undefined,
    });

    expect(interests).toEqual([
      "TypeScript tooling",
      "Local agent autonomy",
    ]);
  });

  it("parses comma-separated interest sections and de-duplicates later sources", () => {
    const interests = deriveCuriosityInterestsFromWorkspaceFiles({
      user: "## Focus\nTypeScript tooling, browser automation, local agents",
      agent: "## Interests\n- Browser automation\n- Runtime tracing",
      identity: undefined,
      soul: undefined,
    });

    expect(interests).toEqual([
      "TypeScript tooling",
      "browser automation",
      "local agents",
      "Runtime tracing",
    ]);
  });

  it("returns no interests when workspace files do not declare them explicitly", () => {
    const interests = deriveCuriosityInterestsFromWorkspaceFiles({
      user: "# User Preferences\n- concise responses",
      agent: "# Role\nHelpful assistant for engineering tasks",
      identity: undefined,
      soul: undefined,
    });

    expect(interests).toEqual([]);
  });
});
