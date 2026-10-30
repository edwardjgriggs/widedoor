# Changelog

All notable changes to Widedoor are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will follow
[Semantic Versioning](https://semver.org/) (0.x: any minor version may break interfaces).

## Unreleased

### Added

#### Phase 3a: the hosted scanner (not deployed)

- An egress policy for hosted scans (`packages/web/src/egress`): http and https on ports 80
  and 443 only; private, loopback, link-local, CGNAT, multicast, reserved and cloud metadata
  addresses refused over IPv4 and IPv6, IPv6 allowed only in `2000::/3`; DNS resolved
  server-side and pinned per host for the scan; an egress proxy that checks every connection,
  redirect and subresource; Chromium launched so it does no DNS of its own and sends nothing
  around the proxy.
- `npm run test:ssrf`: the SSRF suite, the hosted tier's deploy gate.
- robots.txt for hosted crawls: the `Widedoor` group, or `*`.
- The scan machine: Dockerfile target `scan`, whose entry (`docker/scan-entry.sh`) locks Fly's
  machine API socket, loads a kernel firewall, runs the egress proxy as its own user and the
  scan as another, with no token in the scan's environment.
- The hosted API: Dockerfile target `hosted` (`packages/server/src/hosted/api-bin.ts`). One scan
  machine per job through Fly's Machines API, in the API's region, from a scan image pinned by
  digest, destroyed after; per-network rate limits and live job caps (1 running and 1 queued per
  /32 or /64, 2 per /24 or /48), daily and concurrency caps; a report cap per tier (8 MiB open,
  32 MiB verified); reports built by the API from the scan's validated JSON (scan machines send
  no HTML) and kept for 1 hour; domain verification by DNS TXT, a well-known file or a meta
  tag, for the verified tier. The first sweep after a start destroys every leftover scan
  machine; every sweep counts machines the API did not create.
- The hosted page (`packages/ui/hosted.html`): scan a URL or upload a PDF, verify a domain, and
  read the report.
- `fly.toml` for the API app and `fly.scan.toml` for the scan app's image, [docs/hosted.md](docs/hosted.md) (architecture, SSRF controls,
  data handling, limits, known limitations) and [docs/hosted-runbook.md](docs/hosted-runbook.md)
  (deploy, smoke checks, alerts, rotation and rollback).
- Detection: the hosted API's `not_found` and `control_refused` log lines are capped at 20 a
  minute (per client network, per control route), each with one count line after the minute;
  each scan machine ends with an `egress_summary` line counting its refusals by reason.

#### Phase 3b: AI fix suggestions, the MCP server and the docs site

- AI fix suggestions, off by default ([docs/ai-fixes.md](docs/ai-fixes.md)): `--ai-fixes` on
  `widedoor scan`, `ai.enabled` in the config, and `widedoor suggest --report <file>` for an
  existing report. Claude (default model `claude-opus-5-5`) or OpenAI (`ai.model` required),
  with the key from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only. Only failed checks are sent,
  grouped by rule and redacted snippet, with no page URL, host, form value, query string or PDF
  text; the redactor fails closed. `--ai-dry-run` prints exactly what would be sent and sends
  nothing. Limits (`ai.maxGroups`, `ai.maxRequestsPerMinute`, `ai.concurrency`,
  `ai.maxOutputTokens`, `ai.maxInputTokensTotal`) and early stops cap the cost. The results
  go to `ai-suggestions.json` and `ai-suggestions.html` beside the report, every entry labeled
  AI-generated; the report and the exit code never change. Ctrl+C during the suggestions
  writes what it has and keeps the scan's exit code. Model answers are untrusted: a strict
  schema, no links, no unsafe markup, shown as text only. `ai.enabled` in the config alone never
  breaks a scan: without a usable provider it warns once and the scan goes on (`--ai-fixes`
  makes it an error). A signed-in scan needs `ai.allowSignedIn: true`. A report file's own
  rule ids and plain text are treated as untrusted data in the prompt. Every run logs one
  `ai_run` line with what it sent and used.
- AI suggestions in `widedoor ui`: a "Suggest a fix (AI)" button on each automated failed check and
  "Suggest fixes for all", with a confirm step that shows the provider, the model and exactly
  what will be sent. The local server gets the capability from the CLI and never sees the key.
  `ai.maxInputTokensTotal` also caps the whole `widedoor ui` session, and a stopped run keeps
  its document. Whether AI is offered follows the report shown, so a signed-in report hides
  the buttons. `ai.model` and `--ai-model` take `@` and `/` in a model id, as the providers do.
- `widedoor mcp` ([docs/mcp.md](docs/mcp.md)): an MCP server on stdio with four tools
  (`widedoor_scan_url`, `widedoor_scan_pdf`, `widedoor_read_report`, `widedoor_list_reports`).
  It speaks MCP 2026-07-28 (stateless, `server/discover`) and legacy 2025-11-25 through
  `initialize`. Public hosts only by default, behind the hosted egress proxy; `--allow-local`
  for local hosts. Paths and reports stay inside the root folder. Scanned text arrives only in
  `untrustedPageContent`. It never calls an AI provider and takes no credentials.
- A Claude Code skill and an example MCP config (`integrations/claude-code/`).
- The docs site (`packages/docs`, `npm run docs:build`): `README.md` and `docs/*.md` as static
  HTML with no script, passing Widedoor's own scan, with a root `vercel.json` (strict CSP and
  security headers) and a deploy runbook ([docs/docs-site-deploy.md](docs/docs-site-deploy.md)).
  Not deployed.
- Provider keys are kept out of every child process (veraPDF, Docker, Chromium, the browser
  `widedoor ui` opens, and the CLI the GitHub Action runs). The hosted API, agent and images never load the AI code.

### Fixed

- Hotfix: the scan machine's firewall is now one native nftables ruleset (`table inet widedoor`,
  `meta skuid` and `ct original`), loaded with `nft -f`, with the same policy as before. Fly's
  kernel lacks the xt owner match, so the iptables `-m owner` rules failed to load there and no
  hosted scan could run (seen 2026-10-29; the entry failed closed). The scan image ships
  `nftables` instead of `iptables`, and the entry's firewall steps (`entry_failed step=...`)
  are now `nftables` (load) and `nftables_verify` (the table and its drop policies).

## 0.1.0 (2026-10-26)

The first release, as source: the `v0.1.0` tag on GitHub, used from a clone and by the GitHub
Action. No npm package or container image is published.

### Added

#### Phase 0: foundations

- npm workspaces monorepo (`packages/core`, `web`, `pdf`, `report`, `cli`, later `ui` and
  `action`) with strict TypeScript, ESLint (flat config), Prettier and Vitest. Every
  dependency is pinned to an exact version.
- CI workflow (lint, typecheck, tests, `npm audit`, gitleaks) and Dependabot, with actions
  pinned by commit SHA. It runs once a remote exists. `npm run sbom` writes a CycloneDX SBOM.
- Findings schema (`packages/core`): types and a Zod validator for findings, assets,
  locations, sources, criteria, outcomes, reviews and evidence, exported as
  `packages/core/schema/finding.v1.json`, with stable finding ids.
- Standards and mapping data, validated on load: WCAG 2.0 and 2.1 A and AA criteria, Section
  508 provisions and exemptions, the ICT Testing Baseline for Web 3.1 and for Electronic
  Documents 1.0, and the axe-core and veraPDF rule maps. Profiles `508`, `wcag21aa` and
  `508+wcag21aa`, with `pdf.documentType` deciding whether the E205.4 exceptions apply to PDFs.
- Test corpus: web pages with known failures and clean twins for each major rule family, W3C
  ACT rules test cases, generated PDFs (untagged, tagged but broken, clean PDF/UA, scanned image
  only, malformed) and the expected results for each.
- Roll-up from findings and manual reviews to a per-criterion level (Supports, Partially
  Supports, Does Not Support, Not Applicable, Not Evaluated). An automated pass counts only from
  a deciding rule; nothing recorded reads Not Evaluated.

#### Phase 1: web and PDF scan

- Web adapter (`packages/web`): Playwright Chromium with its OS sandbox on and a hardened
  context, axe-core 4.14.0 at 1280x800 plus a 320px reflow pass, URL lists, sitemaps and a
  same-origin crawl with `maxPages`, Playwright storage state for signed-in pages, and an
  escaped snippet and screenshot for each failing element.
- PDF adapter (`packages/pdf`): veraPDF 1.30.3 (PDF/UA-1) in the pinned
  `verapdf/cli:v1.30.3` image with no network, no mounts, a read-only filesystem and memory,
  CPU, process and time limits, or a local veraPDF 1.30.3. Widedoor checks for the displayed
  title, language, image-only pages and bookmarks, and needs-review items for reading order,
  alt text quality and table logic. A malformed PDF gives a scan error, not a crash.
- Reports (`packages/report`): a self-contained HTML report with a strict Content Security
  Policy and plain-language text, the canonical JSON report (`report.v1.json` schema) and SARIF
  2.1.0. Every scanned string is escaped.
- CLI (`packages/cli`): `widedoor scan` for URLs and PDF files, with `widedoor.config.yaml`,
  profiles, formats, `--fail-on` and exit codes 0, 1 and 2, manual review records from
  `widedoor-review/`, a guarded report folder, and cleanup of veraPDF containers on interrupt.
- Local report viewer (`packages/ui`, `widedoor ui`): a React app served on 127.0.0.1 on a
  random port with a one-time access code, rendering scanned strings as text only.
- GitHub Action (`packages/action`): a composite action that builds the CLI from its own
  checkout, scans URLs and files, and uploads SARIF to code scanning.
- Docker image (`Dockerfile`): Node 24 on Debian bookworm, Playwright's Chromium headless
  shell and veraPDF 1.30.3 on a jlinked Temurin 11 runtime, every base image pinned by tag and
  digest, running as a non-root user with no setuid or setgid files. `docker/chromium-seccomp.json`
  lets Chromium keep its OS sandbox without added capabilities. Inside the image, a PDF scan
  records an in-container warning that veraPDF shares the container's network and mounts.
  `npm run test:image` builds and tests it.
- README: install, quick start, Docker use, what is and is not automated, and the disclaimer.
- Config: `pdf.documentType` (`non-web`, the default, or `web`; spec D20) decides whether the
  508 view applies the E205.4 exceptions to PDFs, and the report records it. `web.maxPages`
  sets the page cap with or without a crawl (`web.crawl.maxPages` wins when both are set).
- One rule decides whether a manual review record still counts (`isCurrentRecord` in
  `@widedoor/core`): an expired record leaves the roll-up, fail counts, finding cards, SARIF
  results and the exit gate, and stays listed under the methodology as expired.
- Scope completeness: the JSON report lists its scope gaps (`scopeGaps`), SARIF adds note-level
  notifications for skipped pages and scope gaps and `scopeComplete`, a crawl that cannot read a
  page's links records a gap, a `pdf.include` that matches nothing is a warning and a gap, and
  listed pages left out by the page cap make the run exit 2 after the reports are written.
- CI: the secret scan has its own job ahead of the tests, `npm ci` runs with
  `--ignore-scripts`, and `corpus:verify` runs after the Docker tests.

#### Phase 2: manual review, ACR, report diff and the viewer's screens

- Task 2.1: the 4.1.1 errata basis. The WCAG 2.0 and 2.1 errata say 4.1.1 Parsing is always
  satisfied, so with no failure on it 4.1.1 reads Supports on every scanned asset, with reason
  `errata` and the errata cited from `packages/core/data/errata.yaml`; a fail on 4.1.1, an
  unscanned asset or a scope gap still decides or caps it. No other criterion has an errata
  basis. The findings schema gains optional `asset.reviewHash`, `review.overrides` and
  `review.attachments`, and the roll-up a `manual-override` reason.
- Task 2.2: a review hash for web pages (`asset.reviewHash`). A manual result on a page is
  anchored to a hash of the served HTML with script, noscript and template contents,
  comments, nonce and integrity attributes, token-like attributes, hidden input values and
  whitespace runs normalized away, so a fresh CSRF value or nonce per request no longer expires
  it, and a change to visible content or to an inline stylesheet still does. (Inline style text
  joined the hash after the Phase 2 commit, so results recorded before it on pages with a
  `<style>` block expire once.) For a PDF the review hash is its content hash.
- Task 2.3: manual steps data (`packages/core/data/manual-steps.yaml`, ICT Testing Baseline
  test ids and plain-language steps for each criterion) and the manual review checklist
  generator in `@widedoor/core`: one stable item (`ck_...`) per page or file and criterion that
  no automated check settles, plus product-wide Section 508 items, each with a status (`open`,
  `done`, `expired` or `failed-automated`).
- Task 2.4: `widedoor review list` prints the checklist for a JSON report with the records in
  `widedoor-review/` applied (and the ones it cannot apply, with why), and `widedoor review
record` writes one result (pass, fail or not applicable, notes, overrides and PNG or JPEG
  attachments) under a lock file, so two writers to one file both land.
- Task 2.5: a Manual review section in every report (checklist progress and the "Overridden by
  a reviewer" list), the JSON report's optional `checklist` and `overrides`, a link to the
  errata for a criterion passing on that basis, and `--format junit` (opt-in), which writes
  `report.junit.xml`.
- Task 2.6: PDFs by URL are fetched and scanned. Sources: the new `pdf.urls`, command-line URLs
  ending in `.pdf`, same-origin PDF links a crawl finds (the per-page and per-run caps stay, and
  the rest are a scope gap) and pages served as `application/pdf`. Each fetch keeps every
  redirect on the URL's origin, has 60 seconds, stops at `pdf.maxBytes` (default 50 MiB) and
  needs a body that starts with `%PDF-`. A failed fetch is a scan error (exit 2), too many
  redirects included, except a crawled link whose redirect leaves its origin, which is a scope
  gap. The asset uri is the final URL after redirects, normalized as page URLs are, and the
  report scope lists `pdf.urls`. `pdf.fetch` turns fetching on or off; it is off by default
  inside the Widedoor image, where each PDF URL is then a scope gap. The GitHub Action pulls the
  veraPDF image on every Linux run that has Docker.
- Task 2.7: `--format openacr` (opt-in) writes the scan as an ACR in OpenACR YAML,
  `report.openacr.yaml`, in the layout of the VPAT® 2.5 Revised Section 508 edition: WCAG 2.0
  Level A and AA tables with a Web and an Electronic Documents column, then Chapters 3, 5 and
  6, with Level AAA and Chapter 4 left out with a note. Every level comes from the roll-up's
  Section 508 view; remarks give the roll-up reason, the failing findings (at most 20 per
  cell), overridden fails, profile exceptions and the 4.1.1 errata citation. The output is
  validated against the vendored GSA OpenACR schema and catalog (`packages/report/vendor/openacr`)
  before it is written. A new `acr:` config block holds the vendor, product, notes and report
  date. An ACR format needs a profile with the Section 508 view and `acr.product.name` (exit 2
  otherwise); the ACR is a DRAFT while any row is Not Evaluated, any page or file was not
  scanned, the scope has a gap, or the vendor name, contact or product description is missing.
- Task 2.8: `--format vpat-html` and `--format vpat-docx` (opt-in, with the same rules as
  `openacr`) write the ACR as `report.vpat.html` and `report.vpat.docx` in the section order of
  the ITI VPAT® 2.5Rev Revised Section 508 template, from the same ACR model. A complete ACR is
  titled "<vendor> Accessibility Conformance Report, Revised Section 508 Edition" with "(Based
  on VPAT® Version 2.5Rev)"; a draft is titled "DRAFT <vendor> Accessibility Conformance
  Report", opens with a banner counting the rows not decided and listing each reason, and never
  uses the VPAT name. The HTML is self-contained under the report CSP and passes axe; the DOCX
  has US English, title and author properties, Heading 1 to 3, data tables with a repeating
  header row and no images, dated from the scan so the bytes repeat. New runtime dependencies of
  `@widedoor/report`: `docx` 9.9.0 (MIT) and `jszip` 3.10.2 (MIT or GPL-3.0-or-later, used
  under MIT), which `docx` already depends on.
- Task 2.9: `widedoor diff <before.json> <after.json>` compares two JSON reports: current fail
  and needs-review results that are new, fixed (or set aside by a reviewer) and unchanged, and
  criteria whose level changed. Only pages and files scanned in both reports are compared; the
  rest, and every criterion when the profiles differ, are listed as not compared.
  `--format json` prints the comparison as JSON, and `--fail-on-new` exits 1 when there is a
  new failed check. `diffReports` and its Zod schema are exported from `@widedoor/report`.
- Task 2.10: a new package, `@widedoor/server`, holds the scan engine (`performScan`, what
  `widedoor scan` runs, minus writing and printing), config loading, the report folder rules,
  the report builder shared by `widedoor scan` and the exports, and the `widedoor ui` server.
  `widedoor ui` gains `--root <dir>` (default: the current folder), the folder that holds
  `widedoor.config.yaml` and `widedoor-review/`. The server adds a local API behind the same
  Host check, one-time code and per-run token: scan jobs (`POST /api/scans`, `GET` and
  `DELETE /api/scans/:id`, one at a time, sandbox on, cancel stops the browser, aborts a PDF
  fetch by URL and removes the veraPDF containers), uploads (`POST /api/uploads?kind=pdf|image`,
  a PDF up to 25 MiB, review images under the attachment rules, at most 500 MiB held), the
  checklist and review records (`GET /api/checklist`, `POST /api/reviews`, the same validation
  and lock as `widedoor review record`), attachments and exports of every format
  (`GET /api/export/:format`). Every POST and DELETE needs the server's own `Origin` and a JSON
  body (uploads: the file). A scan job writes nothing to disk: a finished job's report is held
  in memory as the current report and reaches disk only as an export download, and a cancelled
  or failed job leaves the current report alone. A review recorded through the API or with
  `widedoor review record` is applied to a scan job's report at once (the report is rebuilt
  from the scan's results, keeping its times), so the checklist and every export show it; a
  report opened with `--report` stays as scanned, and `GET /api/report` says which (`reviews`).
  The server writes only review records and attachments in `widedoor-review/` and its own temp
  folder, and on start removes the uploads folders that killed servers on this host left
  behind. Uploads are capped at 4 in flight (429) and charged against the held cap before their
  bodies are read. The `widedoor ui` terminal gets one line per scan, review and export, at
  most one per 10 seconds for wrong access codes, and the cause of any server error (the page
  gets only "Server error.").
- Task 2.11: the `widedoor ui` page has four screens behind a nav of buttons: Report (as
  before), Scan (URLs one per line, PDF uploads with a status per file, a profile, Start and
  Cancel, progress in a status region and errors in an alert), Checklist (the manual review
  items grouped by page or file and then criterion, filtered by status, each with its Baseline
  tests, steps, condition, related automated findings and its record as the review files hold
  it now, and a review form under it: outcome, notes, reviewer name remembered in the browser,
  an override checkbox per related automated fail and image attachments) and Export (whether
  the ACR is a draft or complete, with every reason, then a download button per format). A
  screen change moves focus to the page heading, and a recorded result moves it to the item's
  new status. The Report, Checklist and Export screens say when the report is kept only in
  memory ("Export it to keep a copy") or shown as scanned. When the token is refused the page
  says the session has ended and stops calling the server. `GET /api/acr` gives `complete`,
  `incomplete` and `undecided` from the ACR builder the exports use, with the same 422 as an
  ACR export. A scan that ends refreshes Checklist and Export and is announced on any screen;
  the profile is the config's unless chosen; Cancel also stops uploads; Checklist and Export
  have Refresh buttons; downloads are saved as `application/octet-stream`. The server deletes
  an upload nothing used within 15 minutes. `GET /api/checklist` gives each item its record in
  the review files (outcome, reviewer, date, notes, override and attachment counts, and whether
  it is current).
- Override gate on untrusted changes: `widedoor scan --ignore-overrides` makes the exit code
  count automated fails that review records override (reports still show them), and the
  Action's `review-overrides` input (`auto`, the default, `on` or `off`) passes it on pull
  requests and `workflow_run` events from forks, read from the runner's event context (the
  payload file only as a fallback), failing closed when the repositories cannot be read, with
  a notice in the checks.
- ACR exports follow the ITI VPAT 2.5Rev 508 template row by row: Chapter 5 opens with 501.1
  Scope - Incorporation of WCAG 2.0 AA, and 504.2 and 602.3 read "See WCAG 2.x section" (504.2
  shows Not Applicable when a reviewer records that the product is not an authoring tool). These
  rows carry no verdict, so they no longer keep an ACR in draft; a result recorded for 504.2 or
  602.3 is kept in the remarks. OpenACR lists 501.1, 504.2 and 602.3 as chapter notes.
- VPAT HTML and DOCX: the WCAG 2.0 Report introduction, the "Also applies to" lines under each
  Table 1 and 2 row, the template's "Electronic Docs:" cell label, and row titles from the
  OpenACR catalog (the template wording, for example 1.4.4 "Resize text"). The Chapter 5 note
  calls 502.3 and 503.4 heading rows in the template (no response required).
- ACR notes say that 602.3 support documentation is covered by the WCAG tables only where it was
  among the pages and files scanned. A reviewer's records on 504.2 or 602.3 always reach that
  row's remarks (VPAT) and chapter note (OpenACR); records that do not decide the row (N/A on
  some pages but not all) are listed without a level. The checklist still lists both items; a
  504.2 Not Applicable recorded on every page is the only result that sets a row's level.
- A review record for 4.1.1 is refused with the errata basis cited, and `errata.yaml` carries
  the corrected errata dates.

#### Before the 0.1.0 release

- Action output `overrides-ignored` and the log line
  `widedoor event=override_ignored reason=<fork|off>`; the CLI summary counts failed checks a
  reviewer overrode when `--ignore-overrides` is set.
- `widedoor ui` logs counts of refused requests by kind, at most once per 10 seconds.
- Security: `widedoor ui` no longer sends absolute local paths to the page in refusals, job
  errors or scan progress (CWE-209); root-relative names or file names are sent instead, and
  the full cause goes to the terminal.
- Fixed: two processes that met a stale review-file lock at once could orphan a fresh lock and
  stall the next writer for 30 seconds. Taking over a stale lock now goes through one claim
  file per lock, and a fresh lock is never moved aside. The review-lock test that timed out
  under load waits on the writers instead of a fixed sleep.
- Report error and warning text (and so every export) names files relative to the root, or by
  file name for uploads and temp files, never by absolute path. Asset URIs are unchanged.
- With `--ignore-overrides`, the summary's "Set aside by a reviewer" line says those fails
  still count toward the exit code.

### Changed

- Phase 2, Task 2.4: v0.1 review files with free-form `source.ruleId` values (for example
  `keyboard`) are now refused, and so is a record whose `id`, file name, date or item is not the
  one `widedoor review record` would write (see the README). `widedoor scan` exits 2 and names
  the file and the record. Record the result again with `widedoor review record`, or rename the
  rule id to `wcag-<sc>` or `508-<provision>` and move the record to the file the message names.
- Phase 2, Task 2.5: an automated fail that a current manual pass sets aside (an override with
  notes) no longer counts as a fail in the summary, the finding cards, the console or the exit
  code; SARIF keeps it as a suppressed result. A criterion passing on the 4.1.1 errata basis now
  reads "... N assets pass on the errata basis, not on a test: ..." after any scope cap. Review
  records with no checklist item are left out of a scan, except a manual fail on a criterion
  the profile has, which is kept with a warning; records for criteria outside the profile are
  always left out. Left-out records are listed in the report's warnings. `widedoor ui` takes
  `--config` (with `--report`) to find review attachments. Screenshots and attachments are
  embedded only when the whole file is a PNG (or JPEG, for attachments).
- Phase 2, Task 2.6: the `pdf-url` skip reason is gone (viewers still label it in older
  reports), and a run with only PDF URLs no longer exits 2 for "nothing was scanned".
- Phase 2, Task 2.7: `ajv` moves from a development to a runtime dependency of
  `@widedoor/report`.
- Phase 2, Task 2.8: the 4.1.1 errata citation is renamed "ITI Accessibility Conformance Report
  template, Revised Section 508 Edition (2.5Rev), 4.1.1 row" (same URL), which changes that
  remark in every report.
- Phase 2, Task 2.10: the CLI keeps argument parsing, console output, file writing, the exit
  policy and the browser opener, and the rest moves to `@widedoor/server`; `widedoor scan`
  output is unchanged. `widedoor ui --config` now works without `--report` and its folder is
  the root (`--root` and `--config` together exit 2). The viewer's Content Security Policy now
  enforces Trusted Types with no policy
  (`require-trusted-types-for 'script'; trusted-types 'none'`). `hono` and `@hono/node-server`
  move from `@widedoor/cli` to `@widedoor/server` at the same versions; the Docker image copies
  the new package.
- Phase 2, Task 2.11: the server's ACR and config refusals name the ACR formats in general and
  the config by its root-relative name.
- Phase 2 final fixes: writers of one review file in one process (the `widedoor ui` server)
  queue behind each other before they take the lock file. `widedoor review list` and
  `GET /api/checklist` keep the records for a page or file that was in scope but could not be
  scanned, as a scan does, instead of listing them as orphaned. A failed `widedoor ui` scan job
  names a bad review file relative to the root.

### Known issues

- No container image is published with 0.1.0. A trivy scan of the image (2026-10-23) reports
  critical CVEs in Debian bookworm packages that have no fixed version yet: libbrotli1,
  libglib2.0-0, libsqlite3-0 and zlib1g (Chromium needs the first three), and publishing the
  image also needs a source offer for the GPL components it bundles. The `Dockerfile` stays for
  local builds; the CLI and the GitHub Action do not need the image.
- The scanner does not pin DNS answers for the pages and PDFs it fetches, so a host that changes
  its address mid-scan (DNS rebinding) is followed. Fine for scanning sites you choose on your
  own machine; a hosted scanner (Phase 3) must pin them, in Chromium too.
