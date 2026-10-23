# Test corpus

Pages and PDFs with known accessibility findings. The corpus is the regression suite for the
engine adapters: the web adapter must reproduce `expected/` for every web item exactly, and the
PDF adapter must reproduce both the veraPDF and the Widedoor entries for every PDF exactly.

`npm test` checks the corpus offline (manifest, expected files, rule ids). `npm run corpus:verify`
runs the real engines and needs Chromium (`npx playwright install chromium`) and Docker.

## Layout

| Path                     | What it is                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `web/<family>-fail.html` | Static page with one known violation for a rule family                                                  |
| `web/<family>-pass.html` | Its clean twin: the same page with that violation fixed and nothing else changed                        |
| `web/xss.html`           | Hostile strings for the HTML report injection test (not a family)                                       |
| `pdf/*.pdf`              | Five PDFs built by `scripts/build-pdfs.ts`                                                              |
| `act/`                   | W3C ACT rules test cases and their assets of 1 MB or less, vendored verbatim by `scripts/vendor-act.ts` |
| `fonts/`                 | Liberation Sans 2.1.5 (OFL), the only font in the PDFs, with its license and checksums                  |
| `expected/<item>.json`   | Expected findings for one item; `<item>` is the item's path without its extension                       |
| `manifest.json`          | Every corpus file: items with their expected file, plus support files                                   |
| `scripts/`               | Build, vendor and verify scripts (run with tsx from the root `package.json`)                            |
| `test/`                  | Offline Vitest checks, part of `npm test`                                                               |

The ten web families and the axe-core rule each pair targets: labels (`label`), alt
(`image-alt`), contrast (`color-contrast`), headings (`aria-required-attr` on an ARIA heading with
no level), landmarks (`bypass`), aria (`aria-valid-attr-value`), links (`link-name`), tables
(`td-headers-attr`), language (`html-has-lang`, plus `html-lang-valid` on the clean page) and
title (`document-title`).

`web/xss.html` is not a rule family. It holds hostile strings in alt text, `title`, `aria-label`
and element content (`<script>`, `"><img onerror>`, `javascript:` URLs, `</style>`,
`</textarea>`, bidi and control characters, and strings aimed at breaking out of a CSP), so
`packages/report` can render an HTML report from a real scan of it and check that the report is
inert. Its expected file follows the same exact-match rules as the families.

Pages are self-contained: no network requests and no external files (images are `data:` URLs).
Every page has a valid `lang` and a `<title>` except `language-fail.html` and `title-fail.html`.

The PDFs:

- `untagged.pdf`: the report page printed by Chromium without tags.
- `tagged-broken.pdf`: tagged, but the image has no alt text, there is no document language or
  title, and the table's header row uses data cells.
- `clean-pdfua.pdf`: tagged, with the title, language, `DisplayDocTitle` and XMP metadata
  (`dc:title`, `pdfuaid:part` 1) PDF/UA-1 requires. veraPDF 1.30.3 reports zero failed rules.
- `scanned-image-only.pdf`: one page that is only a raster image of the report, no text layer.
- `malformed.pdf`: starts like a PDF but has no objects, cross-reference table or trailer. Both
  engines refuse it; its expected file names the scan error instead of findings.

All five have one page or none, so `pdf-bookmarks` (10 or more pages) is not applicable to any of
them; the PDF adapter tests generate long documents at run time instead of committing them.

## Expected-file format

```json
{
  "item": "web/labels-fail.html",
  "kind": "web",
  "source": "corpus",
  "expected": [{ "engine": "axe-core", "ruleId": "label", "outcome": "fail" }],
  "confirmedBy": "axe-core 4.14.0",
  "provisional": false
}
```

- `item`: path of the item, relative to `corpus/`.
- `kind`: `web` or `pdf`. `source`: `corpus` (made here) or `act` (vendored ACT test case).
- `expected`: entries of `engine` (`axe-core`, `verapdf`, `widedoor`), `ruleId` and `outcome`
  (`pass`, `fail`, `needs-review`, `not-applicable`, `not-tested`). Sorted by engine, rule id and
  outcome. `ruleId` must exist in the engine's map file in `packages/core/data/`
  (`axe-map.yaml`; `verapdf-map.yaml`, mapped or unmapped; `widedoor-map.yaml`). veraPDF ids use
  the `<clause>-<testNumber>` form of `verapdf-map.yaml`.
- An entry may carry `"provisional": true` when the engine that would confirm it does not exist
  yet.
- `error` (optional, `{ "code": "..." }`): the item cannot be scanned. The adapter must report this
  scan error code in run metadata and no findings, so `expected` is empty. Only
  `pdf/malformed.pdf` uses it (`malformed-pdf`).
- `confirmedBy`: the engine and version that confirmed the file, or `null`. PDFs are confirmed by
  both engines: `veraPDF 1.30.3, Widedoor 0.0.0`.
- `provisional`: `true` when anything in the file is not machine-confirmed. The manifest item's
  `note` then says why.

The schema is `ExpectedFileSchema` in `scripts/lib/corpus.ts`.

### Exact match

An engine produces one result per (engine, rule, outcome) triple for an item. For axe-core,
`violations` give `fail`, `incomplete` gives `needs-review`, `passes` give `pass` and
`inapplicable` gives `not-applicable`; one rule can appear with several outcomes on different
nodes. For veraPDF, each rule summary gives `fail`, or `pass` when objects were checked and
`not-applicable` when none were; rules in the `unmapped` section of `verapdf-map.yaml` are run
metadata (`informational`), not findings, but count as veraPDF results here. For the Widedoor PDF
checks, `pdf-image-only` fails per image-only page, `pdf-bookmarks` is `not-applicable` below 10
pages, and `pdf-reading-order` (tagged PDFs), `pdf-alt-text-quality` (PDFs with Figure elements)
and `pdf-table-logic` (PDFs with Table elements) are `needs-review` once per PDF.

For `source: corpus` items, an adapter matches when:

1. its `fail` and `needs-review` triples for that engine equal the file's `fail` and
   `needs-review` entries for that engine, no more and no fewer; and
2. every `pass` and `not-applicable` entry in the file is among its triples.

So the file lists every finding the engine reports (complete), plus passes for the rules the item
targets (not every passing rule). Provisional entries are skipped until their engine exists.

For `source: act` items, the entries name every axe rule that implements the test case's ACT
rule, all with the outcome the ACT test case states (`passed` is `pass`, `failed` is `fail`,
`inapplicable` is `not-applicable`). An adapter agrees when its ACT-level outcome over those
rules equals it: `fail` if any of them fails, else `needs-review` if any is incomplete, else
`pass` if any passes, else `not-applicable`. Every one of those rules must have been evaluated
(listed in some axe result category): a rule axe did not run, such as an experimental or
deprecated one, makes the outcome `not-tested`, and such a test case can never be confirmed.

The ACT outcome is the truth for ACT items: their expected files always hold it. Where axe-core
disagrees, the manifest item carries a `knownDisagreement` (engine version and the exact result)
and the expected file stays `provisional` with `confirmedBy: null`. `corpus:verify` accepts a
known disagreement only when the result is exactly the recorded one. A new disagreement, a known
one that no longer occurs, or an item that agrees but is not recorded fails the run. Test cases in
`manifest.notVendored` (they need an asset over 1 MB) are skipped; each names its pinned upstream
copy and the assets that kept it out.

## Rebuild and verify

```sh
npm run corpus:build    # regenerate pdf/*.pdf
npm run corpus:verify   # axe-core over web/ (and act/), then veraPDF and Widedoor over pdf/
npm run corpus:act      # vendor ACT test cases (see the size limit below)
```

- `scripts/verify-web.ts` scans each page with the shipped web adapter (`@widedoor/web`, built
  first by `tsc -b`), so the corpus tests the code users run: its hardened Chromium context (no
  downloads, service workers or WebSockets, `file:` URLs only inside `corpus/`), axe-core through
  `@axe-core/playwright` with tags `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` (including the
  content of iframes), and the 1280x800 pass merged with the 320x256 reflow pass. The script
  blocks every http(s) request except ACT test cases, which are served at their original W3C URLs
  from `act/` through request routing, so root-relative asset paths resolve offline; ACT paths
  outside `corpus/act/` get a 404. `--record` writes the ACT results back: agreeing test cases
  become confirmed and the rest stay provisional with the axe result in the manifest note. A
  confirmed test case that now disagrees still fails the run and is not rewritten unless
  `--allow-downgrade` is also passed.
- `scripts/verify-pdf.ts` scans each PDF with the shipped PDF adapter (`@widedoor/pdf`, built
  first by `tsc -b`): veraPDF 1.30.3 PDF/UA-1 through its runner (a local CLI at exactly that
  version, else the `verapdf/cli:v1.30.3` image pinned by digest, with no network, no mounts, a
  read-only root, a non-root user and memory, CPU, process and time limits) plus the Widedoor PDF
  checks (pdf.js in a worker thread with a heap cap and a time budget). It compares both engines'
  entries exactly. For an item that expects a scan error it checks the adapter's error code and
  that veraPDF run on its own refuses the file the same way. `npm test` checks the Widedoor entries
  offline; `npm run test:docker` runs the adapter's Docker tests.
- `scripts/build-pdfs.ts` renders HTML with Chromium `page.pdf` (tagged and with an outline where
  the case needs them) and post-processes with pdf-lib: fixed dates, producer and document ID, and
  the PDF/UA metadata for the clean file. It writes `malformed.pdf` from fixed bytes. Two runs on the same machine give byte-identical files.
  The only font is the vendored Liberation Sans, loaded through `@font-face` with no fallback and
  checked against the sha256 in `fonts/source.json`; the build fails if a PDF embeds any other
  font. A different Chromium build can still change the bytes, so rerun `corpus:verify` after a
  rebuild.

## Adding a case

1. Pick the next free name. For a web family, add `web/<family>-fail.html` and its clean twin
   `web/<family>-pass.html`, identical apart from the fix, with `lang` and `<title>`, no network
   resources. For a PDF, add a build step to `scripts/build-pdfs.ts` and run `npm run corpus:build`.
2. Write `expected/<item>.json` from what the case is designed to trigger: every finding you
   expect, plus a `pass` entry for each rule the case targets. Check the rule ids against the map
   files.
3. Add the item to `manifest.json` (`path`, `kind`, `source`, `expected`, `description`, and
   `family` for a web page).
4. Run `npm run corpus:verify`. Reconcile each difference: fix the page if it does not do what you
   meant; fix the expected file if the engine's behavior is right. Record why in the item's `note`
   when the engine's behavior is surprising.
5. Set `confirmedBy` to the engine and version that confirmed it and `provisional` to `false`, or
   leave `provisional: true` with a `note` saying what is not confirmed.
6. Run `npm test`, `npm run lint` and `npm run format:check`.

## Licensing

Everything under `corpus/` except `act/` and `fonts/` is Widedoor's, under the repository license.
`fonts/` holds Liberation Sans 2.1.5, unmodified, under the SIL Open Font License 1.1
(`fonts/LICENSE`); `fonts/source.json` records the release archive, its sha256 and sha512 (the
sha512 matches Fedora's package sources) and the sha256 of each file, which `npm test` checks.

The W3C ACT rules test cases are licensed under the W3C Software and Document License, which
permits redistribution with its notice. `scripts/vendor-act.ts` fetches the test cases of every
ACT rule referenced by `axe-map.yaml`, plus the assets they load, from the repository the W3C site
publishes from (github.com/w3c/wcag-act-rules) at a pinned commit, and writes `act/LICENSE.md`
(the notice) and `act/source.json` (source, commit, retrieval date). Vendored files are verbatim
third-party files: they are excluded from Prettier and from the no-dash rule and must not be
edited. Vendoring also needs an attribution entry for `corpus/act` in the root `NOTICE`, which
`npm test` checks.

The full selection is about 45 MB, almost all of it test video and audio. The script vendors
only assets of 1 MB or less, lists the test cases that need a larger one in
`manifest.notVendored`, and writes nothing if the total would pass 5 MB. `act/source.json`
records the counts and size.

Prettier ignores `corpus/act/`, `corpus/web/` (reformatting could change what a page tests),
`corpus/pdf/` and `corpus/fonts/`. ESLint ignores `corpus/act/` (vendored scripts).
