import type { IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JinxConfig } from "../types/config.js";
import { createTestConfig } from "../__test__/config.js";
import { cancelAllWakes } from "../heartbeat/wake.js";

type WebhookResult = { status: number; body: string };

const state: {
  homeDir: string;
  telegramWebhookResult: WebhookResult;
} = {
  homeDir: "",
  telegramWebhookResult: { status: 200, body: '{"ok":true}' },
};

const telegramWebhookMock = vi.fn(
  async (_body: string, _headers: IncomingHttpHeaders) => state.telegramWebhookResult,
);

vi.mock("../infra/home-dir.js", () => ({
  resolveHomeDir: () => state.homeDir,
  expandTilde: (input: string) => input.replace(/^~(?=\/|$)/, state.homeDir),
  ensureHomeDir: () => state.homeDir,
}));

vi.mock("../gateway/server.js", () => ({
  createGatewayServer: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock("../channels/telegram/bot.js", () => ({
  createTelegramChannel: vi.fn(() => ({
    id: "telegram",
    name: "Telegram",
    capabilities: {
      markdown: true,
      images: true,
      audio: true,
      video: true,
      documents: true,
      reactions: true,
      editing: true,
      streaming: true,
      maxTextLength: 4096,
    },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => "msg-id"),
    isReady: vi.fn(() => true),
    handleWebhookRequest: telegramWebhookMock,
  })),
}));

vi.mock("../channels/whatsapp/bot.js", () => ({
  createWhatsAppChannel: vi.fn(),
}));

vi.mock("../skills/refresh.js", () => ({
  startSkillRefresh: vi.fn(() => vi.fn()),
}));

const { bootGateway } = await import("../gateway/startup.js");

let nextPort = 18990;
function getPort(): number {
  return nextPort++;
}

function request(
  port: number,
  method: string,
  reqPath: string,
  body: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitForServer(port: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      const result = await new Promise<number>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            method: "GET",
            path: "/healthz",
          },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.on("error", () => resolve(0));
        req.end();
      });
      if (result === 200) {
        return;
      }
    } catch {
      // Continue retry loop.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`HTTP server on port ${port} did not become ready`);
}

function createBootConfig(port: number): JinxConfig {
  return createTestConfig({
    sandbox: { enabled: false },
    memory: {
      enabled: true,
      dir: "~/.jinx/memory",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorWeight: 0.7,
      maxResults: 5,
    },
    agents: {
      default: "default",
      list: [{ id: "default", name: "TestJinx", workspace: "~/.jinx/workspace" }],
    },
    channels: {
      terminal: { enabled: true },
      telegram: { enabled: true, botToken: "webhook-token", streaming: true, mode: "webhook" },
      whatsapp: { enabled: false },
    },
    gateway: {
      host: "127.0.0.1",
      port: port + 1000,
      http: {
        enabled: true,
        port,
        hooks: { enabled: true, authToken: "hook-secret" },
      },
    },
  });
}

describe("startup http webhook auth integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.homeDir = mkdtempSync(path.join(tmpdir(), "jinx-startup-http-int-"));
    state.telegramWebhookResult = { status: 200, body: '{"ok":true}' };
    cancelAllWakes();
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    cancelAllWakes();
    rmSync(state.homeDir, { recursive: true, force: true });
  });

  it("enforces webhook auth for /telegram/webhook and routes authorized traffic to the Telegram handler", async () => {
    const port = getPort();
    const boot = await bootGateway(createBootConfig(port));

    await waitForServer(port);

    const unauthorized = await request(port, "POST", "/telegram/webhook", '{"update_id":1}');
    expect(unauthorized.status).toBe(401);
    expect(telegramWebhookMock).not.toHaveBeenCalled();

    const wrongToken = await request(port, "POST", "/telegram/webhook", '{"update_id":2}', {
      Authorization: "Bearer wrong-token",
    });
    expect(wrongToken.status).toBe(401);
    expect(telegramWebhookMock).not.toHaveBeenCalled();

    state.telegramWebhookResult = { status: 200, body: '{"ok":true,"source":"telegram"}' };
    const authorized = await request(port, "POST", "/telegram/webhook", '{"update_id":3}', {
      Authorization: "Bearer hook-secret",
    });
    expect(authorized.status).toBe(200);
    expect(authorized.body).toBe('{"ok":true,"source":"telegram"}');

    expect(telegramWebhookMock).toHaveBeenCalledTimes(1);
    expect(telegramWebhookMock).toHaveBeenCalledWith(
      '{"update_id":3}',
      expect.objectContaining({
        authorization: "Bearer hook-secret",
      }),
    );

    await boot.stop();
  });

  it("enforces auth on /hooks/* and returns no-handler when authorized with no matching hook", async () => {
    const port = getPort();
    const boot = await bootGateway(createBootConfig(port));

    await waitForServer(port);

    const unauthorized = await request(port, "POST", "/hooks/custom", '{"hello":"world"}');
    expect(unauthorized.status).toBe(401);

    const authorized = await request(port, "POST", "/hooks/custom", '{"hello":"world"}', {
      Authorization: "Bearer hook-secret",
    });
    expect(authorized.status).toBe(404);
    expect(JSON.parse(authorized.body)).toEqual({ error: "Not found" });

    await boot.stop();
  });
});
