# Changelog

All notable changes to Widedoor are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions will follow
[Semantic Versioning](https://semver.org/) once releases begin.

## Unreleased (0.1.0)

Nothing is published yet: every package version is still `0.0.0`, there is no git tag, and no
npm package or container image has been released.

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

### Known issues

- A trivy scan of the image (2026-10-23) reports critical CVEs in Debian bookworm packages that
  have no fixed version yet: libbrotli1, libglib2.0-0, libsqlite3-0 and zlib1g. Chromium needs
  the first three. Publishing the image waits on a decision about them.
