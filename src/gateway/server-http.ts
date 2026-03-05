import http from "node:http";
import type { JinxConfig } from "../types/config.js";
import type { SessionStore } from "../types/sessions.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("gateway:http");

export interface HttpServerDeps {
  config: JinxConfig;
  sessions: SessionStore;
  startedAt: number;
}

export type WebhookHandler = (
  path: string,
  body: string,
  headers: http.IncomingHttpHeaders,
) => Promise<{ status: number; body: string }>;

export interface HttpServer {
  start(): void;
  stop(): Promise<void>;
  /** Register a webhook handler for a specific path prefix. */
  onWebhook(handler: WebhookHandler): void;
}

export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { config, sessions, startedAt } = deps;
  const httpConfig = config.gateway.http;
  const host = config.gateway.host;
  const port = httpConfig?.port ?? 9791;
  const hooksConfig = httpConfig?.hooks;

  let server: http.Server | undefined;
  const webhookHandlers: WebhookHandler[] = [];

  function handleHealthz(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const body = JSON.stringify({
      ok: true,
      uptime: Date.now() - startedAt,
      sessions: sessions.list().length,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 1024 * 1024; // 1 MB

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  async function handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<void> {
    // Auth check
    if (hooksConfig?.authToken) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      if (token !== hooksConfig.authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
      return;
    }

    for (const handler of webhookHandlers) {
      try {
        const result = await handler(path, body, req.headers);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
        return;
      } catch (err) {
        logger.error(`Webhook handler error for ${path}: ${err}`);
      }
    }

    // No handler matched
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No handler for webhook path" }));
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    logger.debug(`${method} ${url}`);

    if (url === "/healthz" && method === "GET") {
      handleHealthz(req, res);
      return;
    }

    if (url.startsWith("/hooks/") && method === "POST") {
      if (!hooksConfig?.enabled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Hooks not enabled" }));
        return;
      }
      const hookPath = url.slice("/hooks/".length);
      await handleWebhook(req, res, hookPath);
      return;
    }

    if (url === "/telegram/webhook" && method === "POST") {
      await handleWebhook(req, res, "telegram/webhook");
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  return {
    start() {
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          logger.error(`Request handler error: ${err}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
      });

      server.listen(port, host, () => {
        logger.info(`HTTP server listening on http://${host}:${port}`);
      });
    },

    async stop() {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = undefined;
        logger.info("HTTP server stopped");
      }
    },

    onWebhook(handler: WebhookHandler) {
      webhookHandlers.push(handler);
    },
  };
}
