# Getting Started with OpenJinx

## Quick Start (3 steps)

```bash
# 1. Clone and enter the repo
git clone https://github.com/your-org/OpenJinx.git
cd OpenJinx

# 2. Launch Claude Code
claude

# 3. Run the setup wizard
/setup
```

The `/setup` wizard walks you through everything: installing dependencies, configuring API keys, setting up messaging channels (WhatsApp, Telegram), and verifying your installation.

## Prerequisites

- **Node.js 22.12.0+** — install via [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm)
- **pnpm** — `npm install -g pnpm` or `corepack enable`
- **Claude Code CLI** — install from [claude.ai/claude-code](https://claude.ai/claude-code)

## What `/setup` Configures

| Step               | What it does                                                 |
| ------------------ | ------------------------------------------------------------ |
| Dependencies       | Runs `pnpm install`                                          |
| Assistant name     | Names your assistant (default: Jinx)                         |
| Anthropic API key  | Required for Claude — checks Keychain/OAuth first            |
| OpenAI API key     | Optional — enables vector memory search                      |
| OpenRouter API key | Optional — enables web search via Perplexity                 |
| Composio API key   | Optional — enables GitHub/Slack/Gmail integrations           |
| WhatsApp           | Optional — connects via QR code, locked to your phone        |
| Telegram           | Optional — creates bot via BotFather, locked to your user ID |
| Sandbox            | Checks Apple Container availability (macOS 26+)              |

All credentials are stored locally in `~/.jinx/.env` and never committed to the repo. Channels default to allowlist mode — only you can interact with the bot.

## Manual Setup (without Claude Code)

If you prefer to set up manually:

```bash
# Install dependencies
pnpm install

# Run the onboard command (creates ~/.jinx/ structure)
pnpm dev -- onboard

# Copy and fill in your API keys
cp .env.example ~/.jinx/.env
# Edit ~/.jinx/.env with your keys

# Edit channel config
# Edit ~/.jinx/config.yaml to enable WhatsApp/Telegram

# Verify setup
pnpm dev -- doctor
```

## Post-Setup Commands

```bash
pnpm dev -- gateway    # Start the gateway (WhatsApp + Telegram)
pnpm dev -- chat       # Interactive terminal chat
pnpm dev -- doctor     # System health check
```

## Post-Setup Changes

Run `/customize` in Claude Code to modify your setup after initial configuration — rename the assistant, add channels, update API keys, etc.
