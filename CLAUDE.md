# CLAUDE.md: Widedoor

Open source accessibility checker for websites and PDFs (Section 508 and WCAG 2.1 AA). TypeScript monorepo using npm workspaces under `packages/` (core, web, pdf, report, cli).

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
- `npm run typecheck`: `tsc -b` across every package, plus noEmit checks of core tests and scripts and of `corpus/`
- `npm test`: Vitest (passes with no test files)
- `npm run format`: Prettier
