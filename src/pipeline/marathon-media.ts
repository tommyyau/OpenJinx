import fs from "node:fs/promises";
import path from "node:path";
import type { InputFileInfo } from "../types/marathon.js";
import type { MediaAttachment } from "../types/messages.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("marathon");

const MIME_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
};

export async function seedWorkspaceMedia(
  workspaceDir: string,
  media: MediaAttachment[] | undefined,
): Promise<InputFileInfo[]> {
  if (!media || media.length === 0) {
    return [];
  }

  const results: InputFileInfo[] = [];
  for (const attachment of media) {
    if (!attachment.buffer || attachment.buffer.length === 0) {
      continue;
    }

    const filename = resolveMediaFilename(attachment, results.length);
    const filePath = path.join(workspaceDir, filename);
    await fs.writeFile(filePath, attachment.buffer);

    results.push({
      name: filename,
      sizeBytes: attachment.buffer.length,
      mimeType: attachment.mimeType,
    });
    logger.info(`Seeded workspace media: ${filename} (${attachment.buffer.length} bytes)`);
  }
  return results;
}

function resolveMediaFilename(attachment: MediaAttachment, index: number): string {
  if (attachment.filename) {
    return attachment.filename;
  }

  const ext = MIME_EXTENSIONS[attachment.mimeType] ?? attachment.mimeType.split("/")[1] ?? "bin";
  const prefix = `input-${attachment.type}`;
  return index === 0 ? `${prefix}.${ext}` : `${prefix}-${index + 1}.${ext}`;
}
