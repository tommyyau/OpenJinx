import path from "node:path";
import type { ChunkResult } from "../types/marathon.js";

const SOURCE_LIKE_DELIVERABLE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "swift",
  "kt",
  "scala",
  "sh",
  "bash",
  "zsh",
]);

export interface BuildMarathonCompletionTextParams {
  taskId: string;
  completedChunks: Pick<ChunkResult, "chunkName" | "durationMs">[];
  deliveredNames: string[];
}

export function buildMarathonCompletionText({
  taskId,
  completedChunks,
  deliveredNames,
}: BuildMarathonCompletionTextParams): string {
  const summary = completedChunks
    .map(
      (chunk, index) =>
        `${index + 1}. **${chunk.chunkName}** (${Math.round(chunk.durationMs / 1000)}s)`,
    )
    .join("\n");

  const sourceLikeDeliverables = deliveredNames.filter((name) =>
    SOURCE_LIKE_DELIVERABLE_EXTENSIONS.has(path.extname(name).toLowerCase().slice(1)),
  );

  let text = `Marathon \`${taskId}\` complete!\n\n**Chunks completed:** ${completedChunks.length}\n\n${summary}`;
  if (deliveredNames.length > 0) {
    text += `\n\nArtifacts attached: ${deliveredNames.join(", ")}`;
  }
  if (sourceLikeDeliverables.length > 0) {
    text +=
      "\nNote: Some attached artifacts look like source/workspace files and may require local build/run steps.";
  }

  return text;
}
