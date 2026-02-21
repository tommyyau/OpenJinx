import type { AgentToolDefinition } from "../providers/types.js";
import type { ContainerManager } from "../sandbox/container-manager.js";
import type { JinxConfig } from "../types/config.js";
import { getCoreToolDefinitions } from "../agents/tools/core-tools.js";
import { getExecToolDefinitions } from "../agents/tools/exec-tools.js";
import { getMarathonToolDefinitions } from "../agents/tools/marathon-tools.js";
import { getWebFetchToolDefinitions } from "../agents/tools/web-fetch-tools.js";
import { getWebSearchToolDefinitions } from "../agents/tools/web-search-tools.js";

export interface BuildMarathonChunkToolsParams {
  config: JinxConfig;
  containerManager?: ContainerManager;
  taskId: string;
  sessionKey: string;
  workspaceDir: string;
}

export function buildMarathonChunkTools({
  config,
  containerManager,
  taskId,
  sessionKey,
  workspaceDir,
}: BuildMarathonChunkToolsParams): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [];

  tools.push(
    ...getCoreToolDefinitions({
      allowedDirs: [workspaceDir],
      sessionType: "main",
    }),
  );

  if (containerManager && config.sandbox?.enabled !== false) {
    tools.push(
      ...getExecToolDefinitions({
        workspaceDir,
        sandboxConfig: config.sandbox,
        sessionKey,
        containerManager,
      }),
    );
  }

  tools.push(...getMarathonToolDefinitions({ taskId }));

  const webSearch = config.webSearch;
  if (webSearch?.enabled !== false) {
    tools.push(
      ...getWebSearchToolDefinitions({
        apiKey: webSearch?.apiKey,
        model: webSearch?.model,
        timeoutSeconds: webSearch?.timeoutSeconds,
        cacheTtlMinutes: webSearch?.cacheTtlMinutes,
      }),
    );
  }

  tools.push(
    ...getWebFetchToolDefinitions({
      cacheTtlMinutes: webSearch?.cacheTtlMinutes,
    }),
  );

  return tools;
}
