# CLAUDE.md: Widedoor

Open source accessibility checker for websites and PDFs (Section 508 and WCAG 2.1 AA). TypeScript monorepo using npm workspaces under `packages/` (core, web, pdf, report, cli, ui, action).

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
- No report may emit `pass` or `Supports` for a criterion without a deciding automated rule or a recorded manual result.

## Commands

Run from the repo root. All three must pass before a task is done.

- `npm run lint`: ESLint (flat config, typescript-eslint)
- `npm run typecheck`: `tsc -b` across every package, plus noEmit checks of core tests and scripts, of `corpus/` and of `packages/ui`
- `npm test`: Vitest (passes with no test files)
- `npm run build`: `tsc -b`, then the Vite build of the report viewer (`packages/ui/dist`, served by `widedoor ui`)
- `npm run format`: Prettier
- `npm run test:browser` (Chromium) and `npm run test:docker` (Docker with `verapdf/cli:v1.30.3`, plus Chromium): the suites that drive a browser or veraPDF, including the CLI end-to-end tests. Run `npm run build` before `test:browser`: it checks the shipped `packages/ui/dist`.
- `npm run test:image`: builds `widedoor:dev` from the `Dockerfile` (needs Docker and the pinned veraPDF image) and runs it against the corpus, with Chromium's sandbox kept on by `docker/chromium-seccomp.json`. Not part of `test:docker`. Never push the image or log in to a registry without Edward's OK.
- CLI: `node packages/cli/dist/bin.js scan [urls and PDF files...] [--config] [--profile] [--format] [--out] [--fail-on]` after `tsc -b`, and `node packages/cli/dist/bin.js ui [--report <file>] [--no-open]` after `npm run build` (`--help` lists every flag). Private package, never published without Edward's OK.
- GitHub Action: `packages/action` (composite, `action.yml`). Inputs reach `src/action.ts` only through `INPUT_*` env vars set by the scan step; never put `${{ }}` inside a `run:` block (`action.test.ts` checks this, the SHA pins and the veraPDF digest match). Its end-to-end test is in the docker suite. actionlint (scratchpad binary) lints `.github/workflows` and checks the `with:` keys against `action.yml`, but cannot lint `action.yml` itself. The CI `action` job cannot run until a remote exists.
- `packages/ui` renders text only: ESLint bans HTML string sinks (`dangerouslySetInnerHTML`, `innerHTML`, `document.write` and the rest), raw `<a href>`/`<img src>`, and string eval there, and bans Node built-ins in the browser entries. Browser-safe code it shares comes from `@widedoor/core/browser` and `@widedoor/report/browser` (no Node built-ins).
