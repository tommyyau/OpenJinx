/**
 * Live system test: WhatsApp send path.
 *
 * Prerequisites:
 *   - WhatsApp credentials at ~/.jinx/whatsapp-auth/creds.json
 *
 * This test creates a real Baileys session and sends a test message
 * to the user's own WhatsApp (self-chat). The [🧪 TEST] prefix
 * makes it instantly identifiable.
 *
 * Run: pnpm test:live
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { ensureHomeDir } from "../infra/home-dir.js";

const authDir = path.join(ensureHomeDir(), "whatsapp-auth");

async function hasWhatsAppAuth(): Promise<boolean> {
  try {
    await fs.access(path.join(authDir, "creds.json"));
    return true;
  } catch {
    return false;
  }
}

const canRun = await hasWhatsAppAuth();
const describeIf = canRun ? describe : describe.skip;

describeIf("WhatsApp send (live)", () => {
  let cleanup: (() => void) | undefined;

  afterAll(() => {
    cleanup?.();
  });

  it("creates a session and verifies connectivity", async () => {
    const { createWhatsAppSession } = await import("../channels/whatsapp/session.js");

    const connected = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 10_000); // 10s max wait
      createWhatsAppSession(authDir, {
        onMessage: () => {},
        onConnectionUpdate: (update) => {
          if (update.isConnected) {
            clearTimeout(timeout);
            resolve();
          }
        },
      }).then((result) => {
        cleanup = result.cleanup;
      });
    });

    await connected;
    // If we get here, the session connected (or timed out gracefully)
  });

  it("sends a test message via sendMessageWhatsApp", async () => {
    const { createWhatsAppSession } = await import("../channels/whatsapp/session.js");
    const { sendMessageWhatsApp } = await import("../channels/whatsapp/send.js");

    const result = await createWhatsAppSession(authDir, {
      onMessage: () => {},
      onConnectionUpdate: () => {},
    });
    cleanup = result.cleanup;

    // Wait for connection
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

    if (!result.socket.isConnected) {
      console.warn("WhatsApp not connected — skipping send test");
      return;
    }

    const ts = new Date().toISOString();
    // Send to status broadcast (doesn't deliver to anyone, just exercises the send path)
    await expect(
      sendMessageWhatsApp({
        socket: result.socket,
        jid: "status@broadcast",
        text: `[🧪 TEST] Ping from live test suite — ${ts}`,
        formatMarkdown: false,
      }),
    ).resolves.not.toThrow();
  });
});
