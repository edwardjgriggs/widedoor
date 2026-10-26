# OpenACR schema and catalog

Copied unmodified from the GSA OpenACR repository. `serializeOpenAcr` validates every OpenACR
report against `openacr-0.1.0.json` and checks its chapter, criterion, component and term ids
against the catalog before it returns; `test/openacr.test.ts` checks each file against the
sha256 below.

- Repository: https://github.com/GSA/openacr
- Commit: `86f890a07a2a193d2a9404fb57d2cc2d62a60a4f` (2024-03-12, "Changing conformance criteria
  roll up count from a list to a table (#354)"), the last commit on `main` when retrieved
- Retrieved: 2026-10-24, with curl from `https://raw.githubusercontent.com/GSA/openacr/<commit>/<path>`.
  Each file's git blob id matches the blob at the commit.
- npm package of the same code: `@openacr/openacr` 0.3.8 (not used by Widedoor)

| File                               | Path in the repository                       | sha256                                                             |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `openacr-0.1.0.json`               | `schema/openacr-0.1.0.json`                  | `32d54f873450901965b3eac85189be7e9911971839589a49f63dae29555713e9` |
| `openacr-catalog-0.1.0.json`       | `schema/openacr-catalog-0.1.0.json`          | `41e063a37d725f0ba8fe5f5485b891e5680407acb20a0ddc8668a6d3d0c287cf` |
| `2.5-edition-wcag-2.0-508-en.yaml` | `catalog/2.5-edition-wcag-2.0-508-en.yaml`   | `ddd684cbcf70611cddbd8cec331fe16bceff5099462bb5104b4bc41d2f2e2b9d` |
| `LICENSE.md`                       | `LICENSE.md`                                 | `f19016be10ea3fd63efd98745da1e7ba3d26d3556b71f4ed4b6ddff7ee7ecdfe` |

## License

`LICENSE.md` is the repository's license file. OpenACR is a work of the U.S. government: in the
public domain within the United States, and dedicated worldwide under CC0 1.0 Universal. The
WCAG 2.0 criterion handles in the catalog are W3C material, used under the W3C Software and
Document Notice and License (Copyright 2008 W3C (MIT, ERCIM, Keio)), as `LICENSE.md` says.

## Edition

The repository has no catalog named for VPAT 2.5Rev. The catalog used is the nearest 508
edition: `2.5-edition-wcag-2.0-508-en` (its title reads "VPAT® 2.5 Revised Section 508
Edition"), the Revised Section 508 edition with the WCAG 2.0 tables: Tables 1 to 3, then
Chapters 3 to 6. It has not been compared row by row with the 2.5Rev template. Widedoor reports
Tables 1 and 2 and Chapters 3, 5 and 6.
