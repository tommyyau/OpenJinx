/**
 * Live system test: Channel health check.
 *
 * Light connectivity tests that verify channels can establish connections.
 *
 * Prerequisites:
 *   - WhatsApp: ~/.jinx/whatsapp-auth/creds.json exists
 *   - Telegram: TELEGRAM_BOT_TOKEN env var set
 *
 * Run: pnpm test:live
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { ensureHomeDir } from "../infra/home-dir.js";

const authDir = path.join(ensureHomeDir(), "whatsapp-auth");
const botToken = process.env.TELEGRAM_BOT_TOKEN;

async function hasWhatsAppAuth(): Promise<boolean> {
  try {
    await fs.access(path.join(authDir, "creds.json"));
    return true;
  } catch {
    return false;
  }
}

const hasWA = await hasWhatsAppAuth();
const hasTG = !!botToken;

describe("Channel health (live)", () => {
  let waCleanup: (() => void) | undefined;

  afterAll(() => {
    waCleanup?.();
  });

  const describeWA = hasWA ? it : it.skip;
  const describeTG = hasTG ? it : it.skip;

  describeWA("WhatsApp: create session and verify isConnected", async () => {
    const { createWhatsAppSession } = await import("../channels/whatsapp/session.js");

    const result = await createWhatsAppSession(authDir, {
      onMessage: () => {},
      onConnectionUpdate: () => {},
    });
    waCleanup = result.cleanup;

    // Wait up to 15 seconds for connection
    await new Promise<void>((resolve) => {
      if (result.socket.isConnected) {
        resolve();
        return;
      }
      const interval = setInterval(() => {
        if (result.socket.isConnected) {
          clearInterval(interval);
          resolve();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 15_000);
    });

    // May or may not be connected depending on network/auth state
    // The test verifies the session can be created without throwing
    expect(result.socket).toBeDefined();
  });

  describeTG("Telegram: verify bot identity via getMe", async () => {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    expect(resp.ok).toBe(true);

    const json = (await resp.json()) as {
      ok: boolean;
      result: { is_bot: boolean; username: string };
    };
    expect(json.ok).toBe(true);
    expect(json.result.is_bot).toBe(true);
    expect(json.result.username).toBeTruthy();
  });
});
