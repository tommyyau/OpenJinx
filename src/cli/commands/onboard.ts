import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { resolveHomeDir, ensureHomeDir } from "../../infra/home-dir.js";
import { ensureWorkspace } from "../../workspace/bootstrap.js";

export const onboardCommand = new Command("onboard")
  .description("First-time setup wizard for Jinx")
  .action(async () => {
    console.log("Welcome to Jinx! Let's get you set up.\n");

    // 1. Ensure home directory
    const homeDir = resolveHomeDir();
    ensureHomeDir();
    console.log(`Home directory: ${homeDir}`);

    // 2. Generate config file if missing
    const configPath = path.join(homeDir, "config.yaml");
    if (!fs.existsSync(configPath)) {
      const configYaml = yaml.stringify(DEFAULT_CONFIG, {
        indent: 2,
        lineWidth: 120,
      });
      fs.writeFileSync(configPath, configYaml, "utf-8");
      console.log(`Created config: ${configPath}`);
    } else {
      console.log(`Config already exists: ${configPath}`);
    }

    // 3. Create workspace
    const workspaceDir = path.join(homeDir, "workspace");
    await ensureWorkspace(workspaceDir);
    console.log(`Workspace ready: ${workspaceDir}`);

    // 4. Check Claude auth
    const hasOauth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    if (hasOauth || hasApiKey) {
      console.log(`Claude auth: ${hasOauth ? "OAuth token" : "API key"} found`);
    } else {
      console.log(
        "\nNo Claude auth found. Set one of:\n" +
          "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
          "  export CLAUDE_CODE_OAUTH_TOKEN=...\n",
      );
    }

    console.log("\nSetup complete! Run `jinx chat` to start a conversation.");
    console.log(
      "Tip: For a guided setup experience, run `claude` in the repo root and type `/setup`.",
    );
  });
