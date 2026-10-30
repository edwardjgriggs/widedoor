# Widedoor

Widedoor is an open source accessibility checker that lets a developer or a small business without an accessibility specialist test websites and PDFs against Section 508 and WCAG 2.1 AA. It produces a plain-language report of what is wrong, who it affects, and how to fix it, and a per-criterion summary that never claims conformance it did not test. Each criterion gets one level. It reads "Not Applicable" when the profile, or a manual review that gives a reason, rules it out for every asset in scope. Otherwise, it reads "Partially Supports" when some applicable assets fail it and others pass, and "Does Not Support" when some fail and none pass. It reads "Supports" only when every applicable asset passes through a deciding automated rule, a recorded manual result that is still current, or, for WCAG 4.1.1 Parsing alone, the errata basis: the WCAG 2.0 and 2.1 errata (recorded with their sources in `packages/core/data/errata.yaml`) say 4.1.1 is always satisfied, so a scan with no failure on it reports 4.1.1 Supports on that basis, and every report says so in its reason. Everything else reads "Not Evaluated," including a scan with no assets in scope. An incomplete scope (a truncated crawl, an unreadable sitemap, or a page or file that could not be scanned) turns Supports, and a Not Applicable that rests on a manual review, into "Not Evaluated." Manual results are recorded with `widedoor review` or on the Checklist screen of `widedoor ui` (see Usage), the ACR formats write an Accessibility Conformance Report (ACR) in OpenACR YAML and as HTML and DOCX in the VPAT® 2.5Rev Section 508 layout, and `widedoor diff` compares two reports.

## Status

Version 0.1.0, the first release, published as source (the `v0.1.0` tag). What it does (web
and PDF scans, the reports, manual reviews, the ACR formats, `widedoor diff`, the local viewer
with its scan, checklist and export screens, the GitHub Action and a Dockerfile) is listed in
[CHANGELOG.md](CHANGELOG.md). Nothing is published to npm or a container registry, and
interfaces may still change in any 0.x release.

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
  passed decides the criterion on its own, and no rule is marked as deciding yet, so a criterion
  reaches Supports only through a recorded manual result that is still current, or, for 4.1.1
  Parsing alone, the errata basis described above. A failed check still makes it Does Not
  Support or Partially Supports, 4.1.1 included.
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
widedoor ui --root path/to/site-project
widedoor review list --report widedoor-report/report.json
widedoor review record --report widedoor-report/report.json --item ck_0123456789abcdef \
  --outcome pass --reviewer "Ann Lee" --notes "Tabbed through every control" --attach focus.png
widedoor --help
```

- Web pages are scanned by http or https URL, PDFs as local files or by URL. PDFs need Docker
  with `docker pull verapdf/cli:v1.30.3` (or veraPDF 1.30.3 on PATH, which runs without the
  sandbox).
- Without targets, the scope comes from `widedoor.config.yaml` in the current folder (spec
  section 6). Relative paths in it resolve against its folder. Targets on the command line
  replace its `web.urls`, `web.sitemap`, `pdf.include` and `pdf.urls`.
- PDFs by URL: list them in `pdf.urls`, or give a URL whose path ends in `.pdf` on the command
  line. A crawl also fetches the same-origin PDF links it finds (at most 100 from one page and
  200 per run; the rest are a scope gap), and a page that the server answers with
  `application/pdf` is fetched as a PDF. Every redirect must stay on the origin of the URL, the
  body must start with `%PDF-` (an HTML page named `x.pdf` is a scan error) and may be at most
  `pdf.maxBytes` (default 50 MiB, at most 100 MiB), and each fetch has 60 seconds. A PDF that
  cannot be fetched (too many redirects included) is a scan error (exit 2); a crawled link
  whose redirect leaves its origin is refused and recorded as a scope gap instead. Each PDF
  streams into a private temp folder that is removed after the scan; it is fetched when a scan
  worker is ready for it, so temp disk use is about `--concurrency` x `pdf.maxBytes` (the
  image's `/tmp` tmpfs is 512 MiB). The report records the PDF under its final URL after
  redirects, normalized as page URLs are, so review records for it name that URL. PDFs are
  fetched without the signed-in session of `--storage-state`, and in a signed-in scan a failed
  fetch says so.
- `pdf.fetch` turns fetching PDFs by URL on or off. It is on by default, except inside the
  Widedoor image, where veraPDF would parse the PDFs in the container that has the network
  (on a host, the Docker runner gives veraPDF its own container with `--network none`). With it
  off, each PDF URL is a scope gap, never an error and never a pass. Setting `pdf.fetch: true`
  in the image works and adds a warning that names the trade-off.
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
  with `--format html,json,sarif`. JUnit is not a default: `--format` replaces the list, so
  add it with `--format html,json,sarif,junit`. It writes `report.junit.xml` for CI test
  views: one test suite per page or file, one test case per criterion of the profile's first
  standard (Section 508 under `508+wcag21aa`), failed when the criterion fails there, skipped
  with the reason when it is Not Evaluated. Widedoor marks its report folder with a
  `.widedoor-report` file and clears the reports, `evidence/` and leftover temp files there on
  each run. A folder that is not empty and has no marker (for example `--out .`) is refused, and
  nothing in it is touched. The folder, `evidence/` and the report files must not be symbolic
  links or junctions: Widedoor refuses to write through them (exit 2).
- ACR: `--format openacr` (opt-in, like JUnit) writes `report.openacr.yaml`, an Accessibility
  Conformance Report in OpenACR YAML, and `--format vpat-html,vpat-docx` writes the same ACR as
  `report.vpat.html` and `report.vpat.docx` in the VPAT® 2.5Rev Section 508 layout (see
  [Reports](#reports)). Each ACR format needs a profile with the
  Section 508 view (`508` or `508+wcag21aa`; with `wcag21aa` the run exits 2) and the `acr:`
  block in the config, of which only `product.name` is required (exit 2 without it):

  ```yaml
  acr:
    vendor: { name: Example Agency, contact: accessibility@example.gov }
    product: { name: Permit portal, version: '2.10', description: Online permit applications. }
    notes: Tested on the staging site.
    reportDate: 2026-10-23 # YYYY-MM-DD; default: the date the scan finished
  ```

  Unknown keys are refused, and a version YAML reads as a number (`2.10`) must be quoted.

- Signed-in pages: pass a Playwright storage state with `--storage-state <file>` or
  `WIDEDOOR_STORAGE_STATE`. A config's `web.auth.storageState` must sit inside the config folder.
  Reports of signed-in pages are written private (0600) on POSIX; on Windows they inherit the
  folder's permissions.
- In CI, the gate is only as trustworthy as `widedoor.config.yaml` and `widedoor-review/` on the
  protected branch: a pull request can change both. Pass `--fail-on` explicitly and protect those
  paths (for example with CODEOWNERS). `--ignore-overrides` makes the exit code count automated
  fails that a review record overrides (the reports still show the overrides), for runs on
  changes whose `widedoor-review/` files are not trusted. The summary then says how many
  counted failed checks a reviewer had overridden.
- Manual review records in `widedoor-review/*.yaml` next to the config (or the current folder)
  are added to the report. Records for pages or files outside the run, of the wrong kind, with an
  override the run does not support, replaced by a newer record or for a criterion that is not a
  checklist item there (nothing for a reviewer to decide) are left out, each with a warning line
  on the console and in the report's warnings. The one exception is a manual fail on a criterion
  the profile has but with no checklist item: a reported failure is never hidden, so the scan
  keeps it, with a warning (`review list` warns about it the same way). A record for a
  criterion the profile does not have (Level AAA, or a 508 provision under `wcag21aa`) decides
  nothing in the report and is left out whatever its outcome, with its own warning.
- In the ACR exports, 504.2 and 602.3 read "See WCAG 2.x section", as the ITI template does,
  so a result recorded for either appears only in that row's remarks. The exception is 504.2
  Not Applicable recorded on every page (the product is not an authoring tool), which sets the
  row's level.
- Every report starts with a Manual review section: the checklist progress (items open, done,
  expired and failed by an automated check) and the "Overridden by a reviewer" list, which names
  each automated fail a reviewer set aside as a false positive with the reviewer, date and
  notes. An overridden fail is not a problem in the counts, the cards, the results by criterion
  or the exit code; in SARIF it stays a result with an external suppression whose justification
  is the reviewer's notes. A criterion that passes on the 4.1.1 errata basis says so in its
  reason and links the errata, and the summary names it next to the Supports count. Images
  attached to manual results are embedded in the HTML report (and shown by `widedoor ui`) only
  when the whole file is a PNG or JPEG, read from `widedoor-review/attachments/` through the
  same checks as screenshots; anything else is left out with a note.
- `widedoor review list --report <file>` prints the manual review checklist for a JSON report:
  one item (`ck_...`) per page or file and criterion that no automated check settles, plus one
  per product-wide Section 508 item, each with its status (`open`, `done`, `expired` or
  `failed-automated`). It applies the records in `widedoor-review/` where a scan reads them
  (the folder of `--config <file>`, else the current folder), and lists any it cannot apply,
  with why: a record for a page or file outside the report's scope (orphaned; a page or file in
  scope that could not be scanned keeps its records, as a scan does), for a criterion that
  needs no review there, with an override that names anything but an automated fail on the same
  page or file and criterion, or replaced by a newer record for the same item. It shows the
  `open` items unless `--status` names another status or `all`; `--format json` prints the same
  as JSON.
- `widedoor review record --report <file> --item <ck id> --outcome pass|fail|not-applicable
--reviewer <name>` writes one result to `widedoor-review/<kind>-<hash of the uri>.yaml` (one
  file per page or PDF, sorted by criterion) or `widedoor-review/product.yaml`, and prints the
  file, the record id, the page or file and any overrides. It takes `--config` the same way.
  Recording an item again replaces its result. `--notes` is free text, required for
  `not-applicable` and for `--override <wd id>`, which marks an automated fail on the same page
  or file and criterion as a false positive (with `--outcome pass` only). `--attach <file>` copies
  a PNG or JPEG (checked by its first bytes, up to 5 MiB, 10 per result) to
  `widedoor-review/attachments/<ck id>-<n>-<random>.png` (or `.jpg`), a new name each time, and
  removes the replaced result's images once the new file is written. A result expires when the
  page or file changes, and the next scan shows the item as `expired`. For a PDF, any change to
  its bytes counts. For a web page, the result is tied to a review hash of the served HTML with
  what changes on every request left out: the contents of `script`, `noscript` and `template`
  elements, comments, `nonce` and `integrity` attributes, `data-` attributes whose
  name looks like a token (`csrf`, `xsrf`, `token` or `nonce` in it), the value of a hidden input
  and the value or content of an element whose `name` or `id` looks like a token, and the length
  of whitespace runs. So a page that serves a fresh CSRF value or script nonce each time keeps
  its results, and a change to its visible content (text, `alt` text, labels, headings, link
  targets) or to an inline `<style>` block expires them. A change to a linked stylesheet does
  not, because only the HTML is hashed: re-check visual criteria such as contrast after a
  stylesheet change. A page too deeply nested to normalize falls back to its byte hash,
  which only ever expires a result sooner. A product-wide result is anchored to the first page or file of
  the report and expires when that one changes. Bad input exits 2 and writes nothing.
- Review files may come from a pull request, so Widedoor refuses links and junctions anywhere
  under `widedoor-review/`, attachment paths outside `widedoor-review/attachments/` and
  attachments that are not PNG or JPEG files. A record is refused (the scan or command exits 2,
  naming the file and the record) when its `source.ruleId` is not `wcag-<sc>` or
  `508-<provision>` for the one criterion it cites, its `id` is not the finding id of its asset,
  location and rule, it is not in the file named for its asset (or `product.yaml`), its review
  date is after tomorrow, another record in the folder covers the same item, or it cites 4.1.1,
  which the errata satisfy (no review needed). Writers take a lock file (`<file>.lock`, taken
  over after 30 seconds or when dated in the future), so two writers to one file both land.
  A lock dated more than 5 seconds in the future counts as stale, so on a network share keep
  the clocks of the machines that write reviews in sync (NTP). Keep `widedoor-review/` on a
  file system with hard links (NTFS, ext4, APFS and the like): on FAT, exFAT or some network
  shares, a writer paused for over 30 seconds while holding the lock can, rarely, have it taken
  and a second writer let in.
- An interrupted write can leave `*.lock`, `*.claim`, `*.stale` and `*.tmp` files under `widedoor-review/`.
  Keep them out of git in your repo's `.gitignore`:

  ```gitignore
  **/widedoor-review/**/*.lock
  **/widedoor-review/**/*.lock.*.stale
  **/widedoor-review/**/*.lock.*.claim
  **/widedoor-review/**/.*.tmp
  ```

- `widedoor ui [--report <file>] [--root <dir> | --config <file>] [--no-open]` shows a JSON
  report in a local viewer. It serves on `127.0.0.1` only, on a random port, and prints a link
  with a one-time access code, then opens it in the default browser (unless `--no-open`). The
  page trades the code for a per-run token, so the link works once; reload that tab to keep
  using it. The root folder (`--root`, else the folder of `--config`, else the current folder)
  holds `widedoor.config.yaml` (optional) and `widedoor-review/`.
  Screenshots come from the `evidence/` folder next to the report, and images attached to
  manual results from `widedoor-review/attachments/` in the root. Without `--report`, open a
  `report.json` in the page (the file stays in the browser), or start a scan. Stop it with
  Ctrl+C; a running scan is cancelled. The page has four screens:
  - **Report**: the report, with an outcome and impact filter.
  - **Scan**: URLs (one per line) and PDF files to upload, and a profile (by default the
    config's); leave the URLs and files empty to scan the config's scope. An uploaded PDF is
    recorded under its file name (`annual-report.pdf`), while `widedoor scan` records the path
    it was given (`docs/annual-report.pdf`), so reviews recorded for one do not carry over to the
    other. To share reviews with `widedoor scan` and CI, leave the fields empty and scan the
    config's `pdf.include`. Progress and errors
    are announced; Cancel stops the uploads or the scan. When a scan ends, the other screens
    show its report and the end is announced on whatever screen is open.
  - **Checklist**: the manual review items, grouped by page or file and then criterion, with a
    status filter. Each shows its ICT Testing Baseline tests, steps, condition, related
    automated findings and its record as the review files hold it now (marked when it has
    expired), even when the report shown is older. Record a result under the item: outcome, notes,
    your name (remembered in this browser), automated fails to set aside, and images.
    Refresh reads the checklist again (after `widedoor review record`, for example).
  - **Export**: whether the ACR would be a draft or complete, and why (Check again reads it
    once more), then a download for each format.

  A scan's report is kept only in memory while `widedoor ui` runs, and the Report, Checklist and
  Export screens say so: export it to keep a copy. A report opened with `--report` is shown as
  scanned; run a new scan to include reviews recorded since. A report file you open in the
  page stays shown until you choose the served one again; Checklist and Export always work on
  the report `widedoor ui` holds.

- The `widedoor ui` server has a local API for its page, under the same `127.0.0.1` binding,
  Host check and per-run token, with the server's own `Origin` required on every POST and
  DELETE and JSON request bodies only (uploads send the file itself). It is not a public API
  and is never reachable from another machine. The terminal counts refused requests by kind
  (Host, token, Origin, content type, size, schema, rate) in at most one line per 10 seconds,
  plus one when the server stops. Error text sent to the page names files relative to the root
  folder, or by file name, never by absolute path; a scan job that fails unexpectedly says so
  on the page, and the terminal shows the cause:
  - `POST /api/scans` (`urls`, `pdfs` as upload ids, `profile`, `maxPages`) starts a scan job,
    one at a time, as `widedoor scan` would run it in the root: the request's targets replace
    the config's scope, and everything else (auth, `pdf.fetch`, `acr`, caps) comes from the
    config; `report.formats` does not apply, since exports name their format. Chromium keeps
    its sandbox. `GET /api/scans/:id` gives the status and progress (and the report once
    done); `DELETE /api/scans/:id` cancels it. A finished job's
    report is held in memory as the current report (`GET /api/report`); a cancelled or failed
    job leaves the current report alone. A scan job writes nothing to disk: reports reach disk
    only when you download them from `GET /api/export/<format>`.
  - `POST /api/uploads?kind=pdf` (a PDF up to 25 MiB, `&name=` to name it) and `kind=image` (a
    PNG or JPEG under the attachment rules) hold files in a private temp folder, removed when
    the server stops, until a scan or a review uses them. An upload nothing uses within 15
    minutes is deleted; a cancelled scan's uploads can be scanned again within that time.
  - `GET /api/checklist` and `POST /api/reviews` list and record manual results for the current
    report, with the validation and file lock of `widedoor review list` and `record`. A
    scan job's report is rebuilt with each review recorded, here or with
    `widedoor review record`, so the report and every export show it at once. A report
    opened with `--report` shows the reviews as scanned, and a rescan includes newer ones;
    `GET /api/report` says which (`reviews`: `live` or `as-scanned`).
    `GET /api/attachments/<name>` serves an attached image.
  - `GET /api/export/<format>` downloads the current report as `json`, `html`, `sarif`,
    `junit`, `openacr`, `vpat-html` or `vpat-docx`. The ACR formats need the Section 508 view
    and `acr.product.name`, as with `widedoor scan`. `GET /api/acr` says whether that ACR
    would be complete (`complete`, the `incomplete` reasons and the `undecided` row count).
    Refusals name a config file relative to the root, never by its absolute path.
  - The server writes only review records and their attachments in `<root>/widedoor-review/`
    and its own temp folder for uploads and screenshots, removed when it stops.
- Exit codes: 0 when no failed check is at or above `--fail-on` (default `serious`; `none` turns
  it off), 1 when one is, 2 for a tool error: bad arguments or config, a page or file that could
  not be scanned, listed pages left out by the page cap (the reports are still written), or an
  interrupt. Needs-review results never
  fail a run.

### Compare two reports

```sh
widedoor diff last-week/report.json widedoor-report/report.json
widedoor diff before.json after.json --format json --fail-on-new
```

`widedoor diff <before.json> <after.json>` compares two JSON reports that `widedoor scan`
wrote. It lists the fail and needs-review results that are new, fixed or unchanged (matched by
finding id and page or file), and the criteria whose level changed. Expired manual results do
not count, and an automated fail a reviewer set aside in the after report is listed as fixed,
marked `(override)`.

- Not compared: a result is compared only when its page or file was scanned in both reports.
  A page that is missing from one report, or that could not be scanned or was skipped there,
  gives no new and no fixed results; its results are listed as not compared, with the reason.
  A manual result that is current in one report and expired in the other is not compared
  either. When the profiles differ (`profile.id` or `pdfDocumentType`), every criterion is
  listed as not compared.
- `--format text|json`: `text` (the default) prints counts, the new and fixed results, the
  changed criteria and a not-compared summary; `json` prints the full comparison.
- `--fail-on-new`: exit 1 when the after report has a new failed check. New needs-review
  results and results not compared never count.
- Exit codes: 0, or 1 with `--fail-on-new` as above; 2 on bad input (a missing or unreadable
  file, a file that is not a valid Widedoor JSON report, wrong arguments).

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
  PDFs by URL would break that rule, so the image does not fetch them by default
  (`pdf.fetch`): `pdf.urls`, a `.pdf` URL and the PDF links a crawl finds become scope gaps.
  Download the files and scan them in a PDF run instead. `pdf.fetch: true` fetches and parses
  them in the networked web run, with a warning. A split run (fetch in the web run, parse in a
  `--network none` run) is planned follow-up work.
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

## Hosted scanner

A hosted version runs on Fly.io (not deployed yet): anyone can scan one public page and up to 5
same-origin pages linked from it, or upload one PDF, and a site owner who verifies a host can
crawl up to 200 pages of it. Scans run in a throwaway machine each, locked down so that every
request goes through an egress proxy that refuses private, loopback, link-local, CGNAT,
multicast and cloud metadata addresses. Nothing is stored past 1 hour. How it works, its
limits and what it refuses: [docs/hosted.md](docs/hosted.md). Deploying it:
[docs/hosted-runbook.md](docs/hosted-runbook.md).

## GitHub Action

`packages/action` is a composite action. It builds the CLI from the action's own checkout
(`npm ci --ignore-scripts --include=dev`, a clean `npm run build`, Playwright's Chromium), pulls the pinned veraPDF
image by digest (a URL-only scan can reach PDFs by URL too), runs the scan and uploads
`report.sarif` to code scanning. Nothing is published yet, so pin it by the commit SHA of a Widedoor checkout you
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
      # Pin the full commit SHA of the release, not the tag.
      - id: widedoor
        uses: edwardjgriggs/widedoor/packages/action@46545073d45388ea98393799cbbf165bdb4b9ce6 # v0.1.0
        with:
          urls: |
            https://staging.example.com/
            https://staging.example.com/contact
          files: |
            docs/annual-report.pdf
          fail-on: serious
```

| Input              | Default                     | Meaning                                                                                                                                                                     |
| ------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urls`             |                             | Web pages, one http or https URL per line                                                                                                                                   |
| `files`            |                             | PDF files, one path per line, absolute or relative to the workspace                                                                                                         |
| `config`           |                             | A `widedoor.config.yaml`; without `urls`, `files` or `config`, `./widedoor.config.yaml` is used when present                                                                |
| `profile`          | config, else `508+wcag21aa` | `508`, `wcag21aa` or `508+wcag21aa`                                                                                                                                         |
| `fail-on`          | `serious`                   | `critical`, `serious`, `moderate`, `minor` or `none`; overrides the config's `report.failOn`                                                                                |
| `out`              | `widedoor-report`           | Report folder, absolute or relative to the workspace                                                                                                                        |
| `upload-sarif`     | `true`                      | Upload `report.sarif` to code scanning                                                                                                                                      |
| `sarif-category`   | `widedoor`                  | Code scanning category, to keep several runs apart                                                                                                                          |
| `review-overrides` | `auto`                      | Whether review records that override automated fails count toward the exit code: `auto` ignores them on pull requests from forks, `on` always counts them, `off` never does |

Outputs: `exit-code` (the CLI's), `report-dir` (absolute path of the report folder) and
`overrides-ignored` (`true` when review overrides were not allowed to count toward the exit
code on this run, whether or not one would have changed it; the log then also has
`widedoor event=override_ignored reason=fork` or `reason=off`). To keep
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
  it on a line of a pull request diff. PDF findings point at the PDF file, or at its URL for
  a PDF fetched by URL.
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
  pull request cannot change, such as one checked out from the base branch. Overrides (review
  records that set an automated fail aside) would let a pull request from a fork turn the job
  green, so by default (`review-overrides: auto`) they do not count toward the exit code on a
  `pull_request*` or `workflow_run` event from a fork, or on one whose repositories cannot be
  read; the log and a notice in the checks say so, and the reports still list them.
  `review-overrides: off` ignores them on every run; `on` trusts them everywhere (for example
  under `pull_request_target`, whose default checkout is the base branch). The fork test reads
  the runner's own event context, not a file, but it is only a guard, not a boundary: under
  `pull_request` a fork also supplies the workflow file, so make the scan a required check and
  protect `.github/workflows/`, `widedoor-review/` and `widedoor.config.yaml` with CODEOWNERS;
  run no code from the pull request earlier in the same job; and note that `auto` does not
  recognise other triggers that check out a pull request's code (an `issue_comment` command),
  so set `off` in those workflows.

## Reports

- **HTML**: one self-contained file for people, with no scripts and a strict Content Security Policy.
- **Viewer** (`widedoor ui`): the HTML report's content and wording in a local page, with an
  outcome and impact filter, plus screens to scan, review and export. Scanned strings render as
  text only, under a strict Content Security Policy.
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
- **OpenACR** (`--format openacr`): an ACR in [OpenACR](https://github.com/GSA/openacr) YAML,
  catalog `2.5-edition-wcag-2.0-508-en` (the VPAT® 2.5 Revised Section 508 edition; OpenACR has
  no catalog named for 2.5Rev). Tables 1 and 2 (WCAG 2.0 Level A and AA) have a Web and an
  Electronic Documents column, each levelled from that kind's pages or files; Chapters 3, 5 and
  6 have one cell per row. Level AAA, Chapter 4 (Hardware) and the Software and Authoring Tool
  columns are left out with a note. Levels come from the roll-up's Section 508 view and are
  never raised: an untested row reads Not Evaluated, and 4.1.1 reads Supports with the errata
  cited. The notes say where Widedoor's terms differ from the template's (Does Not Support
  means every page or file with a result fails, not "the majority"). The title starts with
  DRAFT unless every row is decided, every page and file in scope was scanned, the scope has
  no gap, and `acr.vendor.name`, `acr.vendor.contact`, `acr.product.name` and
  `acr.product.description` are set. Each file is checked against the vendored OpenACR schema
  and catalog before it is written; one that fails is a Widedoor bug, reported with exit 2.
- **ACR as HTML and DOCX** (`--format vpat-html`, `--format vpat-docx`): the same ACR as
  `report.vpat.html` (one self-contained file under the HTML report's Content Security Policy,
  checked with axe) and `report.vpat.docx` (Word), in the section order of ITI's VPAT® 2.5Rev
  Revised Section 508 template: product, report date, description, contact, notes, evaluation
  methods, applicable standards, terms, the WCAG 2.0 tables, Chapters 3 to 6 and the legal
  disclaimer. A cell with Web and Electronic Documents parts lists each on its own line
  ("Web: Supports"). A complete ACR is titled "<vendor> Accessibility Conformance Report,
  Revised Section 508 Edition" with the line "(Based on VPAT® Version 2.5Rev)". Any other ACR is
  titled "DRAFT <vendor> Accessibility Conformance Report", opens with a Draft banner that counts
  the rows not decided and lists every reason it is not complete, and does not use the VPAT name
  at all: ITI allows the name only on a report that meets the template's Essential Requirements.
  The DOCX is in US English with title and author properties, Heading 1 to 3 styles, bulleted
  lists and data tables with a repeating header row, and no images; its created and modified
  dates, and the dates inside the file, are the time the scan finished, so the same scan gives
  the same bytes. VPAT is a registered service mark of the Information Technology Industry
  Council (ITI).

## Disclaimer

Every report carries this statement: "This report documents the testing performed. It is not a
certification of conformance." Automated checks find only part of the barriers people meet, a
clean scan does not mean a page or document is accessible, and Widedoor's output is not legal
advice. Conformance claims for Section 508 or WCAG need the manual review that the report lists
as Not Evaluated.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Docker image bundles third-party
software under its own licenses; see [Licenses in the image](#licenses-in-the-image).
