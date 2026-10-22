# Test corpus

Pages and PDFs with known accessibility findings. The corpus is the regression suite for the
engine adapters: the web adapter must reproduce `expected/` for every web item exactly, and the
PDF adapter must reproduce the veraPDF entries for every PDF exactly (and, once Task 1.2 lands,
the Widedoor entries too).

`npm test` checks the corpus offline (manifest, expected files, rule ids). `npm run corpus:verify`
runs the real engines and needs Chromium (`npx playwright install chromium`) and Docker.

## Layout

| Path                     | What it is                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `web/<family>-fail.html` | Static page with one known violation for a rule family                                                   |
| `web/<family>-pass.html` | Its clean twin: the same page with that violation fixed and nothing else changed                         |
| `pdf/*.pdf`              | Four PDFs built by `scripts/build-pdfs.ts`                                                               |
| `act/`                   | W3C ACT rules test cases, vendored verbatim by `scripts/vendor-act.ts` (empty until approved, see below) |
| `expected/<item>.json`   | Expected findings for one item; `<item>` is the item's path without its extension                        |
| `manifest.json`          | Every corpus file: items with their expected file, plus support files                                    |
| `scripts/`               | Build, vendor and verify scripts (run with tsx from the root `package.json`)                             |
| `test/`                  | Offline Vitest checks, part of `npm test`                                                                |

The ten web families and the axe-core rule each pair targets: labels (`label`), alt
(`image-alt`), contrast (`color-contrast`), headings (`aria-required-attr` on an ARIA heading with
no level), landmarks (`bypass`), aria (`aria-valid-attr-value`), links (`link-name`), tables
(`td-headers-attr`), language (`html-has-lang`, plus `html-lang-valid` on the clean page) and
title (`document-title`).

Pages are self-contained: no network requests and no external files (images are `data:` URLs).
Every page has a valid `lang` and a `<title>` except `language-fail.html` and `title-fail.html`.

The PDFs:

- `untagged.pdf`: the report page printed by Chromium without tags.
- `tagged-broken.pdf`: tagged, but the image has no alt text, there is no document language or
  title, and the table's header row uses data cells.
- `clean-pdfua.pdf`: tagged, with the title, language, `DisplayDocTitle` and XMP metadata
  (`dc:title`, `pdfuaid:part` 1) PDF/UA-1 requires. veraPDF 1.30.3 reports zero failed rules.
- `scanned-image-only.pdf`: one page that is only a raster image of the report, no text layer.

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
  yet (the Widedoor PDF checks of Task 1.2).
- `confirmedBy`: the engine and version that confirmed the file, or `null`.
- `provisional`: `true` when anything in the file is not machine-confirmed. The manifest item's
  `note` then says why.

The schema is `ExpectedFileSchema` in `scripts/lib/corpus.ts`.

### Exact match

An engine produces one result per (engine, rule, outcome) triple for an item. For axe-core,
`violations` give `fail`, `incomplete` gives `needs-review`, `passes` give `pass` and
`inapplicable` gives `not-applicable`; one rule can appear with several outcomes on different
nodes. For veraPDF, each rule summary gives `fail` or `pass`.

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

## Rebuild and verify

```sh
npm run corpus:build    # regenerate pdf/*.pdf
npm run corpus:verify   # axe-core over web/ (and act/), then veraPDF over pdf/
npm run corpus:act      # vendor ACT test cases (see the size limit below)
```

- `scripts/verify-web.ts` loads each page in Chromium with every non-file request blocked, injects
  the installed axe-core with tags `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`, and compares.
  ACT test cases are served at their original W3C URLs from `act/` through request routing, so
  root-relative asset paths resolve offline. `--record` writes the ACT results back: agreeing test
  cases become confirmed and the rest stay provisional with the axe result in the manifest note.
  A confirmed test case that now disagrees still fails the run and is not rewritten unless
  `--allow-downgrade` is also passed. WebSockets and `file:` URLs outside `corpus/` are blocked.
- `scripts/verify-pdf.ts` runs `verapdf/cli:v1.30.3` in Docker with `--network none`, flavour
  `ua1`, and compares the veraPDF entries.
- `scripts/build-pdfs.ts` renders HTML with Chromium `page.pdf` (tagged and with an outline where
  the case needs them) and post-processes with pdf-lib: fixed dates, producer and document ID, and
  the PDF/UA metadata for the clean file. Two runs on the same machine give byte-identical files.
  The fonts are the machine's Arial, so a machine without Arial (or a different Chromium build)
  produces different bytes. Rerun `corpus:verify` after a rebuild.

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

Everything under `corpus/` except `act/` is Widedoor's, under the repository license.

The W3C ACT rules test cases are licensed under the W3C Software and Document License, which
permits redistribution with its notice. `scripts/vendor-act.ts` fetches the test cases of every
ACT rule referenced by `axe-map.yaml`, plus the assets they load, from the repository the W3C site
publishes from (github.com/w3c/wcag-act-rules) at a pinned commit, and writes `act/LICENSE.md`
(the notice) and `act/source.json` (source, commit, retrieval date). Vendored files are verbatim
third-party files: they are excluded from Prettier and from the no-dash rule and must not be
edited. Vendoring also needs an attribution entry for `corpus/act` in the root `NOTICE`, which
`npm test` checks.

The selection is about 45 MB, almost all of it test video and audio, so the script refuses to
write more than 5 MB without `--allow-large` and nothing is vendored yet.

Prettier ignores `corpus/act/`, `corpus/web/` (reformatting could change what a page tests) and
`corpus/pdf/`.
