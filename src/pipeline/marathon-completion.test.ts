import { describe, expect, it } from "vitest";
import { buildMarathonCompletionText } from "./marathon-completion.js";

describe("buildMarathonCompletionText", () => {
  it("builds a chunk summary with attached artifact names", () => {
    const text = buildMarathonCompletionText({
      taskId: "marathon-123",
      completedChunks: [
        { chunkName: "scaffold", durationMs: 10_000 },
        { chunkName: "deliver", durationMs: 4_500 },
      ],
      deliveredNames: ["output.zip", "report.pdf"],
    });

    expect(text).toContain("Marathon `marathon-123` complete!");
    expect(text).toContain("1. **scaffold** (10s)");
    expect(text).toContain("2. **deliver** (5s)");
    expect(text).toContain("Artifacts attached: output.zip, report.pdf");
  });

  it("adds source-like warning when attachments look like source files", () => {
    const text = buildMarathonCompletionText({
      taskId: "marathon-123",
      completedChunks: [{ chunkName: "scaffold", durationMs: 1_000 }],
      deliveredNames: ["index.ts", "README.md"],
    });

    expect(text).toContain("look like source/workspace files");
  });

  it("omits source-like warning for packaged artifacts", () => {
    const text = buildMarathonCompletionText({
      taskId: "marathon-123",
      completedChunks: [{ chunkName: "scaffold", durationMs: 1_000 }],
      deliveredNames: ["marathon-123-artifacts.zip"],
    });

    expect(text).not.toContain("look like source/workspace files");
  });
});
