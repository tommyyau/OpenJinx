/**
 * Live system test: Telegram send path.
 *
 * Prerequisites:
 *   - TELEGRAM_BOT_TOKEN env var set
 *   - TELEGRAM_TEST_CHAT_ID env var set (chat ID to send test message to)
 *
 * Run: pnpm test:live
 */
import { describe, it, expect } from "vitest";
import { sendMessageTelegram } from "../channels/telegram/send.js";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const testChatId = process.env.TELEGRAM_TEST_CHAT_ID;

const canRun = !!botToken && !!testChatId;
const describeIf = canRun ? describe : describe.skip;

describeIf("Telegram send (live)", () => {
  it("sends a test message via sendMessageTelegram", async () => {
    const ts = new Date().toISOString();
    const messageId = await sendMessageTelegram({
      botToken: botToken!,
      chatId: testChatId!,
      text: `[🧪 TEST] Ping from live test suite — ${ts}`,
    });

    expect(messageId).toBeGreaterThan(0);
  });

  it("verifies bot identity via getMe", async () => {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    expect(resp.ok).toBe(true);

    const json = (await resp.json()) as { ok: boolean; result: { username: string } };
    expect(json.ok).toBe(true);
    expect(json.result.username).toBeTruthy();
  });
});
