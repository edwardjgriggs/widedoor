# Widedoor

Widedoor is an open source accessibility checker that lets a developer or a small business without an accessibility specialist test websites and PDFs against Section 508 and WCAG 2.1 AA. It produces a plain-language report of what is wrong, who it affects, and how to fix it, and a per-criterion summary that never claims conformance it did not test. Each criterion gets one level. It reads "Not Applicable" when the profile, or a manual review that gives a reason, rules it out for every asset in scope. Otherwise, it reads "Partially Supports" when some applicable assets fail it and others pass, and "Does Not Support" when some fail and none pass. It reads "Supports" only when every applicable asset passes through a deciding automated rule or a recorded manual result. Everything else reads "Not Evaluated," including a scan with no assets in scope. An incomplete scope (a truncated crawl, an unreadable sitemap, or a page or file that could not be scanned) turns Supports, and a Not Applicable that rests on a manual review, into "Not Evaluated." A guided manual review and an Accessibility Conformance Report (ACR) in OpenACR and VPAT 2.5 format are planned for v0.2 and are not built yet.

## Status

Pre-alpha, preparing v0.1. Nothing is published to npm or a container registry yet, and the
interfaces will change. See [CHANGELOG.md](CHANGELOG.md).

## Install

- **npx** (after the first npm release; not published yet): `npx widedoor scan https://example.com/`.
  Needs Node 24, Playwright 1.64.0's Chromium (`npx playwright@1.64.0 install chromium`; another
  Playwright version installs a browser build the CLI does not use) and, for PDFs, Docker
  with `docker pull verapdf/cli:v1.30.3` or veraPDF 1.30.3 on PATH.
- **Docker**: build the image from a clone (no image is published yet):
  `docker build -t widedoor:dev .` It holds the CLI, Chromium and veraPDF 1.30.3, so it needs
  nothing else. See [Docker](#docker) for how to run it.
- **From a clone**: `npm ci` and `npm run build` (which builds every package and the report
  viewer), then run `node packages/cli/dist/bin.js`.

## Quick start

```sh
# From a clone
node packages/cli/dist/bin.js scan https://example.com/ docs/annual-report.pdf
node packages/cli/dist/bin.js ui --report widedoor-report/report.json
```

With the image, scan web pages and PDFs in separate runs; [Docker](#docker) has the commands
and explains each flag.

Open `widedoor-report/report.html` (or the report folder you chose) in a browser. Exit code 1 means a failed check at or above
`--fail-on` (default `serious`).

## What is and is not automated

Automated:

- **Web pages**: axe-core 4.14.0 in Chromium with the WCAG 2.0 and 2.1 A and AA rules, at
  1280x800 and again at 320px wide for reflow, with a screenshot and an escaped snippet of each
  failing element. axe-core results it cannot decide are reported as needs review.
- **PDFs**: veraPDF 1.30.3 with the PDF/UA-1 profile, plus Widedoor's own checks: the title
  shown in the title bar, the document language, pages with no text layer (scanned images) and
  bookmarks in long documents. Reading order, alt text quality and table logic are reported as
  needs review.

Not automated:

- Most of WCAG. Many success criteria (captions, meaningful sequence, focus order, error
  suggestions and others) need a person. Widedoor lists them as Not Evaluated until a manual
  result is recorded in `widedoor-review/*.yaml`.
- An automated pass alone never makes a criterion "Supports". It could only when the rule that
  passed decides the criterion on its own, and in v0.1 no rule is marked as deciding, so a
  criterion reaches Supports only through a recorded manual result. A failed check still makes
  it Does Not Support or Partially Supports.
- A scan covers the pages and files it was given. Criteria that depend on a whole site (for
  example consistent navigation) need a manual review or a scan of every page and file.

## Usage

The examples are the npx form, `widedoor` (once published); from a clone, run
`node packages/cli/dist/bin.js` instead. On a host, one run can mix URLs and PDFs, because
veraPDF gets its own sandboxed container. With the image, scan web pages and PDFs in separate
runs with the commands in [Docker](#docker).

```sh
widedoor scan https://example.com/ docs/annual-report.pdf
widedoor scan --config widedoor.config.yaml --fail-on critical
widedoor ui --report widedoor-report/report.json
widedoor --help
```

- Web pages are scanned by http or https URL, PDFs as local files. PDFs need Docker with
  `docker pull verapdf/cli:v1.30.3` (or veraPDF 1.30.3 on PATH, which runs without the sandbox).
- Without targets, the scope comes from `widedoor.config.yaml` in the current folder (spec
  section 6). Relative paths in it resolve against its folder. Targets on the command line
  replace its `web.urls`, `web.sitemap` and `pdf.include`.
- Page cap: a run scans at most 50 pages. Raise it with `web.maxPages`; with a crawl,
  `web.crawl.maxPages` takes precedence when both are set. Pages you listed in `web.urls` (and the
  sitemap's pages when there is no crawl) are in scope by name: if the cap leaves any unscanned,
  the reports are still written and the run exits 2, naming the count and the setting to raise.
  A crawl that stops at the cap with links still queued is a scope gap, not an error: levels
  that claim something become Not Evaluated, and the exit code is unaffected.
- `pdf.documentType` (spec D20): `non-web` (the default) treats PDFs as non-web documents, so
  under Section 508 the E205.4 exceptions mark SC 2.4.1, 2.4.5, 3.2.3 and 3.2.4 Not Applicable
  for every PDF. Set `web` when your PDFs count as web content (for example, documents your
  public site links to and your counsel treats as web pages); the exceptions then do not apply.
  Command-line targets do not replace it, and the report records it (`profile.pdfDocumentType`).
- A `pdf.include` that matches no file is a warning and a scope gap in every report, not a
  silent empty PDF scope.
- Reports go to `./widedoor-report/report.html`, `report.json` and `report.sarif`, with
  screenshots in `./widedoor-report/evidence/`. Change the folder with `--out` and the formats
  with `--format html,json,sarif`. Widedoor marks its report folder with a
  `.widedoor-report` file and clears the reports, `evidence/` and leftover temp files there on
  each run. A folder that is not empty and has no marker (for example `--out .`) is refused, and
  nothing in it is touched. The folder, `evidence/` and the report files must not be symbolic links or junctions:
  Widedoor refuses to write through them (exit 2).
- Signed-in pages: pass a Playwright storage state with `--storage-state <file>` or
  `WIDEDOOR_STORAGE_STATE`. A config's `web.auth.storageState` must sit inside the config folder.
  Reports of signed-in pages are written private (0600) on POSIX; on Windows they inherit the
  folder's permissions.
- In CI, the gate is only as trustworthy as `widedoor.config.yaml` and `widedoor-review/` on the
  protected branch: a pull request can change both. Pass `--fail-on` explicitly and protect those
  paths (for example with CODEOWNERS).
- Manual review records in `widedoor-review/*.yaml` next to the config (or the current folder)
  are added to the report.
- `widedoor ui [--report <file>] [--no-open]` shows a JSON report in a local viewer. It serves
  on `127.0.0.1` only, on a random port, and prints a link with a one-time access code, then
  opens it in the default browser (unless `--no-open`). The page trades the code for a
  per-run token, so the link works once; reload that tab to keep using it. Screenshots come
  from the `evidence/`
  folder next to the report. Without `--report`, open a `report.json` in the page; the file
  stays in the browser. The viewer never scans. Stop it with Ctrl+C.
- Exit codes: 0 when no failed check is at or above `--fail-on` (default `serious`; `none` turns
  it off), 1 when one is, 2 for a tool error: bad arguments or config, a page or file that could
  not be scanned, listed pages left out by the page cap (the reports are still written), or an
  interrupt. Needs-review results never
  fail a run.

## Docker

The image (`Dockerfile`, built locally as `widedoor:dev`; nothing is published) holds Node 24
on Debian bookworm, Playwright's Chromium headless shell and veraPDF 1.30.3 on a Temurin 11
runtime. Its entrypoint is the `widedoor` CLI, its working folder is `/work`, and it runs as
the non-root user `widedoor` (uid and gid 10001).

Tested on Docker Desktop for Windows (WSL 2) only. Linux hosts are untested: AppArmor
(Docker's `docker-default` profile, or Ubuntu 23.10 and later with
`kernel.apparmor_restrict_unprivileged_userns=1`) may block the user namespaces Chromium's
sandbox needs, and a web scan then stops with "Chromium could not start with its OS sandbox".

Scan web pages and PDFs in separate runs. `WIDEDOOR` is the path of your Widedoor clone, which
holds the seccomp profile; run the scans from your project folder.

```sh
# In the Widedoor clone
docker build -t widedoor:dev .
WIDEDOOR="$PWD"

# Web pages. Only the report folder is mounted, writable.
mkdir -p widedoor-report/web
docker run --rm --init --user "$(id -u):$(id -g)" --cap-drop ALL \
  --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m \
  --security-opt seccomp="$WIDEDOOR/docker/chromium-seccomp.json" \
  -v "$PWD/widedoor-report/web:/work/out" \
  widedoor:dev scan https://example.com/ --out out

# PDFs. No network, the PDFs read-only, the report folder writable, Docker's default seccomp.
mkdir -p widedoor-report/pdf
docker run --rm --init --user "$(id -u):$(id -g)" --network none --cap-drop ALL \
  --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m \
  -v "$PWD/docs:/work/docs:ro" -v "$PWD/widedoor-report/pdf:/work/out" \
  widedoor:dev scan docs/annual-report.pdf --out out
```

In PowerShell (Docker Desktop for Windows), drop `--user` (Docker Desktop already gives the
files in a bind mount to you), use `${PWD}`, and end continued lines with a backtick:

```powershell
$env:WIDEDOOR = 'C:\path\to\widedoor'
New-Item -ItemType Directory -Force widedoor-report\web | Out-Null
docker run --rm --init --cap-drop ALL `
  --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m `
  --security-opt "seccomp=$env:WIDEDOOR\docker\chromium-seccomp.json" `
  -v "${PWD}\widedoor-report\web:/work/out" `
  widedoor:dev scan https://example.com/ --out out

# PDFs. No network, the PDFs read-only, the report folder writable, Docker's default seccomp.
New-Item -ItemType Directory -Force widedoor-report\pdf | Out-Null
docker run --rm --init --network none --cap-drop ALL `
  --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m `
  -v "${PWD}\docs:/work/docs:ro" -v "${PWD}\widedoor-report\pdf:/work/out" `
  widedoor:dev scan docs/annual-report.pdf --out out
```

The `sh` commands also work in Git Bash on Windows with two
changes: run `export MSYS_NO_PATHCONV=1` first (or Git Bash rewrites `/work/out` and `/tmp`
into Windows paths), and set `WIDEDOOR="$(pwd -W)"` instead of `"$PWD"` (the Docker client
reads the seccomp profile and needs a Windows path, such as `C:/path/to/widedoor`).

What each part does:

- **`--user "$(id -u):$(id -g)"`**: required on Linux. Without it the scan runs as uid 10001,
  which cannot write to a folder you own, and it stops with exit 2 and an EACCES ("permission
  denied") error on the report folder. With it the reports belong to you. The image runs as
  any uid. Create the host folders first (`mkdir -p`): a folder Docker creates for a missing mount source belongs
  to root on Linux.
- **`--init`**: a small init process that reaps Chromium's child processes and passes Ctrl+C
  on. Use it on every run.
- **Hardening**: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` and the
  `/tmp` tmpfs work with the image for web and PDF scans. The image also has no setuid or setgid
  files. The bundled veraPDF caps its heap at 1 GiB, so a `--memory` limit below about 2g can
  stop large PDFs.
- **Mounts**: mount only what a scan needs. A web scan needs only the report folder. To scan
  from a config, add it read-only, for example
  `-v "$PWD/widedoor.config.yaml:/work/widedoor.config.yaml:ro"` (and `widedoor-review/` the same
  way), and keep `--out out`. A config for a web run must not list PDFs in `pdf.include`:
  the run has the network on and the seccomp profile applied, so PDFs belong in a PDF run.
  Do not mount your whole project read-write: the container renders
  untrusted pages and parses untrusted PDFs.
- **Chromium's sandbox stays on.** Docker's default seccomp profile blocks the namespace calls
  Chromium's sandbox needs, so a web scan without the profile stops with "Chromium could not
  start with its OS sandbox". `docker/chromium-seccomp.json` is Docker's default profile (moby
  `docker-v29.6.1`) plus one rule that allows `clone`, `unshare` and `chroot`, which Chromium
  uses to build its user, PID and network namespace sandbox. It needs no added capability: do
  not use `--cap-add SYS_ADMIN`, `--privileged`, `seccomp=unconfined` or `--unsafe-no-sandbox`.
  The Docker client reads the profile file, so the path is one on the machine where you run
  `docker`. [docker/README.md](docker/README.md) says how to regenerate it.
- **veraPDF has no sandbox of its own in the image.** On a host, Widedoor runs veraPDF in a
  separate container per PDF with no network and a read-only filesystem. In the image it runs
  as a plain process, so the container is its only boundary, and every report from the image
  that scanned a PDF carries a warning that says so. That is why PDF scans use
  `--network none` and read-only input mounts.
- **Trust notes**: the seccomp rule applies to every process in the container, not only
  Chromium. Any code that runs there, a compromised veraPDF included, can create user
  namespaces, which Docker's default profile would refuse. Scan PDFs in runs without the
  profile, as above, so that only web scans carry it.
- **A site on your own machine**: from the container, `localhost` is the container itself. On
  Docker Desktop use `http://host.docker.internal:<port>/`. On Linux (untested), add
  `--add-host=host.docker.internal:host-gateway` and serve on an address the container can
  reach.
- `widedoor ui` serves on the container's own loopback address, which the host cannot reach.
  Open `report.html`, or run `widedoor ui` from a clone.
- `npm run test:image` builds `widedoor:dev` and runs it against the corpus with these flags
  (web pages served from a second container on an internal network, PDFs through a read-only
  mount). With `WIDEDOOR_TEST_IMAGE=<image>` it tests that image instead and builds nothing.

### Licenses in the image

Widedoor is Apache-2.0, but the image also bundles:

- veraPDF 1.30.3 (GPL-3.0-or-later or MPL-2.0)
- a Temurin 11 Java runtime (GPL-2.0 with the Classpath Exception)
- Chromium's headless shell (its own license file, under `/ms-playwright`)
- Node.js and the npm packages in `/app/node_modules`
- the Debian packages of the base system and Chromium's libraries (`/usr/share/doc/*/copyright`)

`/app/THIRD-PARTY-NOTICES.txt` in the image lists where each one's license and source are, and
the `org.opencontainers.image.licenses` label names the main licenses. Building the image
locally is fine. Before an image is published, a source offer (or the corresponding source)
for the GPL components must go with it.

## GitHub Action

`packages/action` is a composite action. It builds the CLI from the action's own checkout
(`npm ci --ignore-scripts --include=dev`, a clean `npm run build`, Playwright's Chromium), pulls the pinned veraPDF
image by digest when PDFs may be in scope, runs the scan and uploads `report.sarif` to code
scanning. Nothing is published yet, so pin it by the commit SHA of a Widedoor checkout you
trust. It runs on Linux runners (`ubuntu-latest`); PDFs need Docker, which GitHub-hosted Ubuntu
runners have.

```yaml
name: Accessibility

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  widedoor:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # SARIF upload; drop it with upload-sarif: false
      actions: read # SARIF upload in a private repository only
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # PLACEHOLDER: replace OWNER and the SHA with a reviewed Widedoor commit.
      - id: widedoor
        uses: OWNER/widedoor/packages/action@0000000000000000000000000000000000000000
        with:
          urls: |
            https://staging.example.com/
            https://staging.example.com/contact
          files: |
            docs/annual-report.pdf
          fail-on: serious
```

| Input            | Default                     | Meaning                                                                                                      |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `urls`           |                             | Web pages, one http or https URL per line                                                                    |
| `files`          |                             | PDF files, one path per line, absolute or relative to the workspace                                          |
| `config`         |                             | A `widedoor.config.yaml`; without `urls`, `files` or `config`, `./widedoor.config.yaml` is used when present |
| `profile`        | config, else `508+wcag21aa` | `508`, `wcag21aa` or `508+wcag21aa`                                                                          |
| `fail-on`        | `serious`                   | `critical`, `serious`, `moderate`, `minor` or `none`; overrides the config's `report.failOn`                 |
| `out`            | `widedoor-report`           | Report folder, absolute or relative to the workspace                                                         |
| `upload-sarif`   | `true`                      | Upload `report.sarif` to code scanning                                                                       |
| `sarif-category` | `widedoor`                  | Code scanning category, to keep several runs apart                                                           |

Outputs: `exit-code` (the CLI's) and `report-dir` (absolute path of the report folder). To keep
the HTML report, add an `actions/upload-artifact` step (pinned by SHA) with
`path: ${{ steps.widedoor.outputs.report-dir }}` and `if: ${{ !cancelled() }}`: without that
`if`, the step is skipped whenever the scan fails, which is when the report matters.

- **Exit codes**: the scan step exits with the CLI's code: 0 when no failed check is at or above
  `fail-on`, 1 when one is, 2 for a tool error (bad input, a page or PDF that could not be
  scanned, listed pages left out by the page cap, an empty scope). The SARIF upload still runs after a 1 or 2 when `report.sarif`
  exists, and then the job fails. `fail-on: none` stops failed checks from failing the step,
  but a scan error still exits 2. To never fail the step, put `continue-on-error: true` on it
  and read `exit-code`.
- **Fork pull requests**: GitHub gives a `pull_request` run from a fork a read-only token, so
  the SARIF upload fails there. Turn it off for forks only, for example
  `upload-sarif: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}`,
  and keep the reports as an artifact instead. Do not switch to `pull_request_target` to get
  write access: it would run the scan with secrets on code from the fork.
- **Web SARIF results do not attach to files**: a web finding points at the page URL with the
  CSS selector as a logical location, so code scanning lists it as an alert but cannot show
  it on a line of a pull request diff. PDF findings point at the PDF file.
- **Inputs are data, not script**: each input reaches the scan through an environment variable
  and the entry script builds the CLI arguments itself, with no shell. URLs must be http or
  https, targets follow `--` so none can become a flag, and enum inputs are checked. The CLI
  output runs under `::stop-commands::`, so a scanned page cannot inject workflow commands into
  the log.
- The action runs `actions/setup-node` (Node 24) for the rest of the job, and on GitHub-hosted
  Ubuntu runners allows the unprivileged user namespaces the Chromium sandbox needs. A
  self-hosted runner keeps its own AppArmor policy, so the sandbox must already work there.
- **Secrets**: the scan renders untrusted pages in Chromium, and the CLI and browser inherit the
  step's environment. Never put secrets in the `env` of this step or its job; for a signed-in
  scan, write a Playwright storage state file in an earlier step and point the config at it.
- **Self-hosted runners** reuse the action's download folder between jobs. The action reinstalls
  `node_modules` and deletes every `dist` folder before it builds, but a runner shared with
  untrusted jobs can still change the sources there; prefer ephemeral runners.
- **What the gate trusts**: the threshold is the `fail-on` input (default `serious`), which
  always overrides the config. On a pull request, the config's scope and `widedoor-review/`
  (manual results that can mark items reviewed) come from the pull request's own branch, so a
  change to them changes what is scanned and what passes. Require review of those paths (for
  example with CODEOWNERS and branch protection), or pass `config` pointing at a file the
  pull request cannot change, such as one checked out from the base branch.

## Reports

- **HTML**: one self-contained file for people, with no scripts and a strict Content Security Policy.
- **Viewer** (`widedoor ui`): the HTML report's content and wording in a local page, with an
  outcome and impact filter. Scanned strings render as text only, under a strict Content
  Security Policy.
- **JSON**: the canonical record of a scan, validated by `packages/report/schema/report.v1.json`.
  `scopeGaps` lists what made the scope incomplete beyond scan errors and skipped pages.
- **SARIF 2.1.0**: for developer tools. Results for PDFs point at the file. Results for web pages
  point at the page URL with the CSS selector as a logical location, so GitHub code scanning
  accepts them but cannot attach them to lines of source code; use web SARIF for dashboards and
  alert lists, not for file annotations. Only current fail records are results (an expired
  manual review is not one), and a fail with no impact is level `error`, as it trips the gate.
  `executionSuccessful` is false only for scan errors; skipped pages (up to 20, then a count)
  and scope gaps are note-level tool notifications, and `runs[0].properties.scopeComplete` is
  false when anything was left out.

## Disclaimer

Every report carries this statement: "This report documents the testing performed. It is not a
certification of conformance." Automated checks find only part of the barriers people meet, a
clean scan does not mean a page or document is accessible, and Widedoor's output is not legal
advice. Conformance claims for Section 508 or WCAG need the manual review that the report lists
as Not Evaluated.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Docker image bundles third-party
software under its own licenses; see [Licenses in the image](#licenses-in-the-image).
