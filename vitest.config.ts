import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    pool: "forks",
    include: ["src/**/*.test.ts"],
    exclude: [
      "dist/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
      "src/__integration__/**",
      "src/**/__integration__/**",
      "src/__system__/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/entry.ts",
        "src/index.ts",
        "src/cli/**",
        "src/tui/**",
        "src/types/**",
        // Gateway requires external WebSocket connections
        "src/gateway/**",
        // Channel adapters requiring live bot connections
        "src/channels/telegram/bot.ts",
        "src/channels/telegram/dispatch.ts",
        "src/channels/telegram/send.ts",
        "src/channels/telegram/streaming.ts",
        "src/channels/telegram/access.ts",
        "src/channels/telegram/monitor.ts",
        "src/channels/telegram/media.ts",
        "src/channels/telegram/config.ts",
        "src/channels/whatsapp/session.ts",
        "src/channels/whatsapp/login-qr.ts",
        "src/channels/whatsapp/monitor.ts",
        "src/channels/whatsapp/media.ts",
        "src/channels/whatsapp/access.ts",
        "src/channels/whatsapp/config.ts",
        // Test helpers (not production code)
        "src/__test__/**",
      ],
    },
  },
});
