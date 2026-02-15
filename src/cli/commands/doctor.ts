import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JinxConfig } from "../../types/config.js";
import { resolveConfigPath } from "../../config/loader.js";
import { loadAndValidateConfig } from "../../config/validation.js";
import { fetchWithRetry } from "../../infra/fetch-retry.js";
import { resolveHomeDir } from "../../infra/home-dir.js";
import { hasAuth, resolveAuth } from "../../providers/auth.js";

type CheckStatus = "ok" | "fail" | "skip" | "warn";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const LIVE_TIMEOUT_MS = 5_000;

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "fail":
      return "FAIL";
    case "skip":
      return "SKIP";
    case "warn":
      return "WARN";
  }
}

function printSection(title: string, checks: CheckResult[]): void {
  console.log(`  ${title}:`);
  for (const check of checks) {
    console.log(`  [${statusIcon(check.status)}] ${check.name}: ${check.detail}`);
  }
  console.log();
}

// ── Tier 1: Structure checks ───────────────────────────────────────────

function runStructureChecks(): CheckResult[] {
  const checks: CheckResult[] = [];

  const homeDir = resolveHomeDir();
  checks.push({
    name: "Home directory",
    status: fs.existsSync(homeDir) ? "ok" : "fail",
    detail: homeDir,
  });

  const configPath = resolveConfigPath();
  const configExists = !!configPath && fs.existsSync(configPath);
  checks.push({
    name: "Config file",
    status: configExists ? "ok" : "fail",
    detail: configPath ?? "not found",
  });

  const workspaceDir = path.join(homeDir, "workspace");
  checks.push({
    name: "Workspace",
    status: fs.existsSync(workspaceDir) ? "ok" : "fail",
    detail: workspaceDir,
  });

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  checks.push({
    name: "Node.js",
    status: nodeMajor >= 22 ? "ok" : "fail",
    detail: nodeVersion,
  });

  return checks;
}

// ── Tier 2: Live API validation ────────────────────────────────────────

async function checkClaudeAuth(): Promise<CheckResult> {
  if (!hasAuth()) {
    return { name: "Claude auth", status: "fail", detail: "No auth found" };
  }

  try {
    const auth = resolveAuth();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    if (auth.mode === "api-key") {
      headers["x-api-key"] = auth.key;
    } else {
      headers["authorization"] = `Bearer ${auth.token}`;
    }

    const resp = await fetchWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      },
      0,
    );

    if (resp.ok) {
      const mode = auth.mode === "oauth" ? "OAuth token" : "API key";
      return { name: "Claude auth", status: "ok", detail: `${mode} valid` };
    }

    if (resp.status === 401) {
      return {
        name: "Claude auth",
        status: "fail",
        detail: "401 Unauthorized — check your API key",
      };
    }

    // 400, 403, etc. — auth is likely valid but request may be malformed
    // For a health check, if we get past 401 the key is valid
    const mode = auth.mode === "oauth" ? "OAuth token" : "API key";
    return { name: "Claude auth", status: "ok", detail: `${mode} valid (status ${resp.status})` };
  } catch (err) {
    return { name: "Claude auth", status: "fail", detail: `Connection error: ${String(err)}` };
  }
}

async function checkOpenAiEmbeddings(): Promise<CheckResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { name: "OpenAI embeddings", status: "skip", detail: "key not set (BM25 only)" };
  }

  try {
    const resp = await fetchWithRetry(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "health check",
        }),
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      },
      0,
    );

    if (resp.ok) {
      return {
        name: "OpenAI embeddings",
        status: "ok",
        detail: "key valid (text-embedding-3-small)",
      };
    }

    if (resp.status === 401) {
      return {
        name: "OpenAI embeddings",
        status: "fail",
        detail: "401 Unauthorized — check your API key",
      };
    }

    return { name: "OpenAI embeddings", status: "fail", detail: `HTTP ${resp.status}` };
  } catch (err) {
    return {
      name: "OpenAI embeddings",
      status: "fail",
      detail: `Connection error: ${String(err)}`,
    };
  }
}

async function checkOpenRouterWebSearch(): Promise<CheckResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { name: "OpenRouter web search", status: "skip", detail: "key not set" };
  }

  try {
    const resp = await fetchWithRetry(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "perplexity/sonar-pro",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      },
      0,
    );

    if (resp.ok) {
      return {
        name: "OpenRouter web search",
        status: "ok",
        detail: "key valid (perplexity/sonar-pro)",
      };
    }

    if (resp.status === 401) {
      return {
        name: "OpenRouter web search",
        status: "fail",
        detail: "401 Unauthorized — check your API key",
      };
    }

    return { name: "OpenRouter web search", status: "fail", detail: `HTTP ${resp.status}` };
  } catch (err) {
    return {
      name: "OpenRouter web search",
      status: "fail",
      detail: `Connection error: ${String(err)}`,
    };
  }
}

async function checkComposio(config: JinxConfig | undefined): Promise<CheckResult> {
  if (!config?.composio.enabled) {
    return { name: "Composio", status: "skip", detail: "not enabled" };
  }

  const apiKey = config.composio.apiKey ?? process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return { name: "Composio", status: "fail", detail: "enabled but no API key set" };
  }

  try {
    const resp = await fetchWithRetry(
      "https://backend.composio.dev/api/v1/connectedAccounts",
      {
        method: "GET",
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      },
      0,
    );

    if (resp.ok) {
      return { name: "Composio", status: "ok", detail: "key valid" };
    }

    if (resp.status === 401) {
      return { name: "Composio", status: "fail", detail: "401 Unauthorized — check your API key" };
    }

    return { name: "Composio", status: "fail", detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { name: "Composio", status: "fail", detail: `Connection error: ${String(err)}` };
  }
}

async function runApiChecks(config: JinxConfig | undefined): Promise<CheckResult[]> {
  const results = await Promise.all([
    checkClaudeAuth(),
    checkOpenAiEmbeddings(),
    checkOpenRouterWebSearch(),
    checkComposio(config),
  ]);
  return results;
}

// ── Tier 3: Channel & security checks ──────────────────────────────────

async function checkTelegram(config: JinxConfig | undefined): Promise<CheckResult> {
  if (!config?.channels.telegram.enabled) {
    return { name: "Telegram", status: "skip", detail: "not enabled" };
  }

  const tg = config.channels.telegram;
  if (!tg.botToken) {
    return { name: "Telegram", status: "fail", detail: "enabled but no botToken set" };
  }

  // Verify token with getMe
  try {
    const resp = await fetchWithRetry(
      `https://api.telegram.org/bot${tg.botToken}/getMe`,
      { method: "GET", signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) },
      0,
    );

    if (!resp.ok) {
      return {
        name: "Telegram",
        status: "fail",
        detail: `bot token invalid (HTTP ${resp.status})`,
      };
    }

    const data = (await resp.json()) as { result?: { username?: string } };
    const username = data.result?.username ?? "unknown";

    const chatIds = tg.allowedChatIds ?? [];
    if (chatIds.length === 0 && tg.dmPolicy !== "disabled") {
      return {
        name: "Telegram",
        status: "warn",
        detail: `bot @${username} responding, but no allowedChatIds set — consider adding your user ID`,
      };
    }

    return {
      name: "Telegram",
      status: "ok",
      detail: `bot @${username} responding, locked to ${chatIds.length} user(s)`,
    };
  } catch (err) {
    return { name: "Telegram", status: "fail", detail: `Connection error: ${String(err)}` };
  }
}

function checkWhatsApp(config: JinxConfig | undefined): CheckResult {
  if (!config?.channels.whatsapp.enabled) {
    return { name: "WhatsApp", status: "skip", detail: "not enabled" };
  }

  const wa = config.channels.whatsapp;
  const authDir = wa.authDir ?? path.join(resolveHomeDir(), "whatsapp-auth");
  const credsFile = path.join(authDir, "creds.json");
  const hasCredentials = fs.existsSync(credsFile);

  const allowFrom = wa.allowFrom ?? [];

  if (!hasCredentials) {
    return {
      name: "WhatsApp",
      status: "warn",
      detail: "enabled but no credentials found — scan QR code on first gateway start",
    };
  }

  if (allowFrom.length === 0 && wa.dmPolicy !== "disabled") {
    return {
      name: "WhatsApp",
      status: "warn",
      detail: "credentials present, but no allowFrom set — consider adding your phone number",
    };
  }

  const maskedNumbers = allowFrom.map((n) =>
    n.length > 6 ? n.slice(0, 4) + "xxx" + n.slice(-2) : n,
  );
  return {
    name: "WhatsApp",
    status: "ok",
    detail: `credentials present, locked to ${maskedNumbers.join(", ")}`,
  };
}

function checkSandbox(): CheckResult {
  if (process.platform !== "darwin") {
    return { name: "Sandbox", status: "skip", detail: "Apple Container (macOS only)" };
  }

  try {
    execSync("container list 2>/dev/null", { timeout: 3_000, stdio: "pipe" });
    return { name: "Sandbox", status: "ok", detail: "Apple Container available" };
  } catch {
    return { name: "Sandbox", status: "skip", detail: "Apple Container not available" };
  }
}

async function runChannelChecks(config: JinxConfig | undefined): Promise<CheckResult[]> {
  const telegram = await checkTelegram(config);
  return [telegram, checkWhatsApp(config), checkSandbox()];
}

// ── Main ────────────────────────────────────────────────────────────────

export const doctorCommand = new Command("doctor")
  .description("Check system health and configuration")
  .action(async () => {
    console.log("Jinx Doctor - System Health Check\n");

    // Tier 1: Structure
    const structureChecks = runStructureChecks();
    printSection("Structure", structureChecks);

    // Try to load config for Tier 2 & 3
    let config: JinxConfig | undefined;
    try {
      config = await loadAndValidateConfig();
    } catch {
      // Config may not exist or be invalid — continue with what we can check
    }

    // Tier 2: API keys (live validation)
    const apiChecks = await runApiChecks(config);
    printSection("API Keys (live validation)", apiChecks);

    // Tier 3: Channels & security
    const channelChecks = await runChannelChecks(config);
    printSection("Channels & Security", channelChecks);

    // Summary
    const allChecks = [...structureChecks, ...apiChecks, ...channelChecks];
    const hasFail = allChecks.some((c) => c.status === "fail");
    const hasWarn = allChecks.some((c) => c.status === "warn");

    if (hasFail) {
      console.log("Some checks failed.");
    } else if (hasWarn) {
      console.log("All checks passed (with warnings).");
    } else {
      console.log("All checks passed!");
    }

    process.exitCode = hasFail ? 1 : 0;
  });
