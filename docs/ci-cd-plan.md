# CI/CD Plan for OpenJinx

Status: **Not yet implemented** — recommendations for when the repo goes public on GitHub.

## Overview

OpenJinx's existing scripts (`pnpm check`, `pnpm test`, `pnpm build`) already form the CI pipeline — they just run manually. GitHub Actions automates them so every push and PR is verified before merging.

## Pre-Push Checklist

Before the first public push to GitHub, verify:

1. **No secrets in git history** — run `git log --all --diff-filter=A -- '*.env' '.env*'` to confirm no `.env` files were ever committed. If found, rewrite history before going public.
2. **`.gitignore` covers sensitive paths** — ensure `.env`, `~/.jinx/`, `node_modules/`, `dist/`, `coverage/` are all excluded.
3. **No hardcoded credentials** — grep for API key patterns: `git log -p --all -S 'sk-ant-' -S 'sk-or-' -S 'ANTHROPIC_API_KEY=' | head -50`
4. **Package.json metadata** — verify `repository.url`, `homepage`, `bugs.url` point to the correct GitHub repo.
5. **License file** — confirm `LICENSE` exists at repo root (MIT per package.json).

## CI Workflow Design

### Jobs and What They Run

| Job                   | Script                  | Triggers             | Runtime | Cost        |
| --------------------- | ----------------------- | -------------------- | ------- | ----------- |
| **Lint & Types**      | `pnpm check`            | Every push, every PR | ~10s    | Free        |
| **Unit Tests**        | `pnpm test`             | Every push, every PR | ~6s     | Free        |
| **Build**             | `pnpm build`            | Every push, every PR | ~5s     | Free        |
| **Integration Tests** | `pnpm test:integration` | Every push, every PR | ~15s    | Free        |
| **Coverage Report**   | `pnpm test:coverage`    | PRs only             | ~10s    | Free        |
| **Live API Tests**    | `pnpm test:live`        | Manual dispatch only | ~30s    | API credits |

The first four jobs should run in parallel — they're independent and fast. Total wall time ~15s.

### Workflow File

The workflow goes in `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: Lint & Types
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check

  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build

  integration:
    name: Integration Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration

  coverage:
    name: Coverage
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:coverage

  live:
    name: Live API Tests
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:live
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

### Key Design Choices

- **`pnpm install --frozen-lockfile`** — fails if `pnpm-lock.yaml` is out of sync with `package.json`. Catches cases where someone added a dependency but forgot to commit the lockfile.
- **`concurrency` with `cancel-in-progress`** — if you push twice in quick succession, the first run gets cancelled. Saves minutes.
- **`pnpm/action-setup@v4`** — reads `packageManager` from `package.json` to get the exact pnpm version (10.23.0). No manual version pinning needed.
- **Coverage on PRs only** — no point running it on direct pushes to main. On PRs it gives reviewers a signal.
- **Live tests behind `workflow_dispatch`** — never runs automatically. You click "Run workflow" in the GitHub UI when you want to verify API integrations. Prevents accidental API spend.

## GitHub Repository Settings

### Branch Protection Rules (on `main`)

Once CI is running, enable these on the `main` branch:

- **Require status checks to pass before merging**: select `check`, `test`, `build`, `integration`
- **Require branches to be up to date before merging**: prevents merge skew
- **Require pull request reviews**: at least 1 approval (optional for solo dev, good habit)
- **Do not allow bypassing the above settings**: even for admins

### Secrets

Add these in Settings > Secrets and variables > Actions:

| Secret               | Purpose                | Used by         |
| -------------------- | ---------------------- | --------------- |
| `ANTHROPIC_API_KEY`  | Live test Claude calls | `live` job only |
| `OPENAI_API_KEY`     | Live test embeddings   | `live` job only |
| `OPENROUTER_API_KEY` | Live test web search   | `live` job only |

Never expose secrets to PR workflows from forks — GitHub does this by default, but verify under Settings > Actions > General > "Fork pull request workflows."

## Node Version Matrix (Optional)

For forward-compatibility testing, add a matrix strategy:

```yaml
strategy:
  matrix:
    node-version: [22, 24]
```

This catches Node.js deprecations early. Not critical for 0.1 but useful before relying on newer Node APIs.

## What This Doesn't Cover (Yet)

- **Release automation** — publishing to npm, creating GitHub releases with changelogs. Not needed until you're distributing the package.
- **Docker builds** — not applicable for a local-first app.
- **Deployment** — OpenJinx runs on the user's machine, not a server. No deploy step needed.
- **Dependabot / Renovate** — automated dependency updates. Worth enabling once public to stay on top of security patches.

## Quick Reference

When you're ready to implement:

1. Create `.github/workflows/ci.yml` with the content above
2. Push to GitHub
3. Go to Settings > Branches > Add rule for `main`
4. Add API key secrets if you want live tests
5. Verify first CI run passes

Total setup time: ~15 minutes.
