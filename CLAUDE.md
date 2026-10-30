# CLAUDE.md: Widedoor

Open source accessibility checker for websites and PDFs (Section 508 and WCAG 2.1 AA). TypeScript monorepo using npm workspaces under `packages/` (core, web, pdf, report, ai, server, cli, ui, action, docs).

## Source documents

- Plan: `C:\Users\edwar\Desktop\ai-workspace\.claude\handoffs\2026-10-21-widedoor-plan.md`
- Spec (binding): `C:\Users\edwar\Desktop\ai-workspace\.claude\handoffs\2026-10-21-widedoor-design.md`
- Decisions log: `C:\Users\edwar\Desktop\ai-workspace\.claude\handoffs\2026-10-21-widedoor-decisions.md`
- Ledger and pre-flight rulings: `C:\Users\edwar\Desktop\ai-workspace\.claude\handoffs\2026-10-21-widedoor-ledger.md`

## Rules

- No em dashes or en dashes anywhere (code, comments, docs, tests, commit messages). Code that must match them uses `\u2013` and `\u2014` escapes.
- No commits without Edward's OK. No push or remote creation without his explicit OK. Plain commit messages, no AI trailers. Run git from Windows git.
- No secrets in the repo. Run `gitleaks` before any push.
- Pin every dependency to an exact version (`.npmrc` sets `save-exact=true`). No AGPL dependencies.
- Escape all scanned content in every report path. Never render untrusted strings with `innerHTML` or `dangerouslySetInnerHTML`.
- No report may emit `pass` or `Supports` for a criterion without a deciding automated rule, a recorded manual result, or the 4.1.1 errata basis recorded in `packages/core/data`.
- `@widedoor/ai` never reaches hosted code: nothing under `packages/server/src/hosted`, `packages/ui/src/hosted` or the `scan` and `hosted` image targets loads it (`hosted-no-ai.test.ts` and the image tests check). `@widedoor/server` never depends on or imports `@widedoor/ai`, not even for types; the CLI hands the local server its AI capability. The CLI loads `@widedoor/ai` only by the one dynamic import in `packages/cli/src/ai.ts`.
- Provider keys come from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only, are never logged or written, and are stripped from every child process (`withoutProviderEnv`).
- `.gitattributes` keeps the `Dockerfile` (and `docker/*.sh`) LF; the Dockerfile tests read it line by line.

## Commands

Run from the repo root. All three must pass before a task is done.

- `npm run lint`: ESLint (flat config, typescript-eslint)
- `npm run typecheck`: `tsc -b` across every package, plus noEmit checks of core tests and scripts, of `corpus/` and of `packages/ui`
- `npm test`: Vitest (passes with no test files)
- `npm run build`: `tsc -b`, then the Vite build of the report viewer (`packages/ui/dist`, served by `widedoor ui`)
- `npm run format`: Prettier
- `npm run test:browser` (Chromium) and `npm run test:docker` (Docker with `verapdf/cli:v1.30.3`, plus Chromium): the suites that drive a browser or veraPDF, including the CLI end-to-end tests. Run `npm run build` before `test:browser`: it checks the shipped `packages/ui/dist`.
- `npm run test:ssrf` (Chromium): the SSRF suite, the deploy gate of the hosted tier. It drives Chromium through `scanWeb` and Node fetches through the egress proxy and proves nothing reaches a private address; the hosted tier ships only while it passes.
- `npm run test:image`: builds `widedoor:dev` from the `Dockerfile` (needs Docker and the pinned veraPDF image) and runs it against the corpus, with Chromium's sandbox kept on by `docker/chromium-seccomp.json`. It also builds the `scan` and `hosted` targets and runs the scan machine's lockdown tests (`docker/scan-entry.sh`, the nftables firewall, the egress proxy as uid 10002, the agent) on internal Docker networks (targets on 11.0.0.0/24, never the internet); those need a Linux kernel with nftables and `--cap-add NET_ADMIN`. Not part of `test:docker`. Never push the image or log in to a registry without Edward's OK.
- CLI: `node packages/cli/dist/bin.js scan [urls and PDF files...] [--config] [--profile] [--format] [--out] [--fail-on] [--ignore-overrides]` after `tsc -b`, and `node packages/cli/dist/bin.js ui [--report <file>] [--root <dir> | --config <file>] [--no-open]` after `npm run build` (the root holds `widedoor.config.yaml` and `widedoor-review/`; the page scans, reviews and exports through the token-protected local API in `packages/server`; scan jobs keep reports in memory and write nothing to disk, reports reach disk only as export downloads, and the server writes only to `widedoor-review/` and its own temp folder), `review list|record [--config]` for manual review files in `widedoor-review/`, and `diff <before.json> <after.json> [--format text|json] [--fail-on-new]` to compare two JSON reports (`--help` lists every flag). Private package, never published without Edward's OK.
- AI fix suggestions: `node packages/cli/dist/bin.js scan ... --ai-fixes [--ai-dry-run] [--ai-provider anthropic|openai] [--ai-model <id>]`, or `suggest --report <file> [--out <dir>] [--config <file>] [--ai-dry-run]` for an existing report (off by default; see `docs/ai-fixes.md`). Never run them against a real provider in tests; the unit project fails any socket to a non-loopback address from `packages/ai` tests.
- MCP server: `node packages/cli/dist/bin.js mcp [--root <dir>] [--config <file>] [--allow-local]` (stdio; MCP 2026-07-28 and legacy 2025-11-25; see `docs/mcp.md`). `@modelcontextprotocol/sdk` is a devDependency of the CLI for the conformance test only, never imported at run time.
- `npm run docs:build`: the docs site (`packages/docs`) from `README.md` and `docs/*.md` into `packages/docs/dist`; not part of `npm run build`. `vercel.json` sits at the repo root. Never run `vercel` or deploy without Edward's OK (`docs/docs-site-deploy.md`).
- GitHub Action: `packages/action` (composite, `action.yml`). Inputs reach `src/action.ts` only through `INPUT_*` env vars set by the scan step; never put `${{ }}` inside a `run:` block (`action.test.ts` checks this, the SHA pins and the veraPDF digest match). Its end-to-end test is in the docker suite. actionlint (scratchpad binary) lints `.github/workflows` and checks the `with:` keys against `action.yml`, but cannot lint `action.yml` itself. The CI `action` job cannot run until a remote exists.
- `packages/ui` renders text only: ESLint bans HTML string sinks (`dangerouslySetInnerHTML`, `innerHTML`, `document.write` and the rest), raw `<a href>`/`<img src>`, and string eval there, and bans Node built-ins in the browser entries. Browser-safe code it shares comes from `@widedoor/core/browser` and `@widedoor/report/browser` (no Node built-ins).
