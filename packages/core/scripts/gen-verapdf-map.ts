import { fetchText, writeYaml } from './lib/write-yaml.ts';

// Builds data/verapdf-map.yaml. Rule ids come from the PDF/UA-1 validation
// profile at a pinned commit (the profile itself is not vendored). Every rule
// must be classified below, either mapped to WCAG SC with a basis or listed as
// unmapped with a reason; an unclassified or stale entry fails the run.
//
// Basis sources: W3C Techniques for WCAG 2.1, PDF1 to PDF23
// (https://www.w3.org/WAI/WCAG21/Techniques/#pdf), each of which states the SC it
// relates to, and the PDF Association Matterhorn Protocol 1.1 checkpoints.
const REPO = 'veraPDF/veraPDF-validation-profiles';
const BRANCH = 'rel/1.30';
const COMMIT = 'c4f57effb0d3618827c87bd71882930d752be6e3';
const PROFILE = 'PDF_UA/PDFUA-1.xml';

type Mapped = { wcag: string[]; basis: string };
type Unmapped = { reason: string };

const TAGGED: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'Every W3C PDF technique for structure (PDF6, PDF9, PDF21) applies to tagged PDF; without a valid structure tree, structure and relationships are not programmatically determinable (SC 1.3.1).',
};
const ARTIFACT: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'Matterhorn checkpoint 01 (real content tagged). Real content must sit in the structure tree and only incidental content may be an Artifact (PDF4), or structure is not programmatically determinable (SC 1.3.1).',
};
const ROLE_MAP: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'Matterhorn checkpoint 02 (role mapping). Assistive technology reads semantics from standard structure types, which PDF6, PDF9 and PDF21 rely on for SC 1.3.1.',
};
const TITLE: Mapped = {
  wcag: ['2.4.2'],
  basis:
    'PDF18 (document title, shown via DisplayDocTitle) relates to SC 2.4.2 Page Titled (Sufficient with G88).',
};
const LANG: Mapped = {
  wcag: ['3.1.1', '3.1.2'],
  basis:
    'PDF16 (default language via /Lang) relates to SC 3.1.1; PDF19 (/Lang for passages) relates to SC 3.1.1 and 3.1.2.',
};
const TABLE: Mapped = {
  wcag: ['1.3.1'],
  basis: 'PDF6 (table elements for table markup) and PDF20 relate to SC 1.3.1.',
};
const LIST: Mapped = {
  wcag: ['1.3.1'],
  basis: 'PDF21 (List tags for lists) relates to SC 1.3.1.',
};
const TOC: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'Matterhorn checkpoint 09 (appropriate tags). TOC and TOCI nesting is how a table of contents structure is programmatically determined (SC 1.3.1).',
};
const HEADING: Mapped = {
  wcag: ['1.3.1'],
  basis: 'PDF9 (heading tags) relates to SC 1.3.1.',
};
const FIGURE_ALT: Mapped = {
  wcag: ['1.1.1'],
  basis: 'PDF1 (Alt entry as text alternative for images) relates to SC 1.1.1.',
};
const FORMULA_ALT: Mapped = {
  wcag: ['1.1.1'],
  basis:
    'A formula without Alt or ActualText is non-text content without a text alternative; PDF1 is the Alt technique for SC 1.1.1.',
};
const NOTE_ID: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'Matterhorn checkpoint 19 (notes and references). Unique Note ids let the reference-to-note relationship be programmatically determined (SC 1.3.1).',
};
const ANNOT_TAGGED: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'Matterhorn checkpoint 28 (annotations). Annotations outside the structure tree are outside structure and reading order; PDF11 uses the same structure-plus-annotation pattern for SC 1.3.1.',
};
const ANNOT_ALT: Mapped = {
  wcag: ['1.1.1'],
  basis: "An annotation's Contents or Alt entry is its text alternative (SC 1.1.1).",
};
const FIELD_NAME: Mapped = {
  wcag: ['1.3.1', '4.1.2'],
  basis:
    'PDF10 and PDF12: the TU entry or Alt supplies the accessible name of a form field (SC 4.1.2; also SC 1.3.1).',
};
const TAB_ORDER: Mapped = {
  wcag: ['2.4.3'],
  basis: 'PDF3 (correct tab and reading order) relates to SC 2.4.3 Focus Order.',
};
const WIDGET: Mapped = {
  wcag: ['1.3.1', '4.1.2'],
  basis:
    'PDF12 (name, role, value for form fields): the Form structure element exposes the role of the widget (SC 4.1.2, 1.3.1).',
};
const LINK_TAGGED: Mapped = {
  wcag: ['1.3.1', '2.4.4'],
  basis: 'PDF11 (Link annotation with Link structure element) relates to SC 1.3.1 and 2.4.4.',
};
const LINK_ALT: Mapped = {
  wcag: ['2.4.4'],
  basis: 'PDF13 (replacement text for links) relates to SC 2.4.4.',
};
const MEDIA_ALT: Mapped = {
  wcag: ['1.1.1'],
  basis:
    'SC 1.1.1 requires time-based media to have a text alternative that at least identifies it; the media clip Alt key carries it.',
};

const UNICODE: Mapped = {
  wcag: ['1.1.1', '1.3.1'],
  basis:
    'WCAG defines text as a sequence of characters that can be programmatically determined, and non-text content as any content that is not. Glyphs without a Unicode mapping cannot be extracted by assistive technology, so they are non-text content without a text alternative (SC 1.1.1) and their information is not programmatically determinable (SC 1.3.1).',
};
const AT_PERMISSION: Mapped = {
  wcag: ['1.3.1', '4.1.2'],
  basis:
    'If the encryption permissions deny content extraction for accessibility, assistive technology cannot read the text, structure or form fields, so structure (SC 1.3.1) and name, role and value of controls (SC 4.1.2) are not programmatically determinable.',
};
const DYNAMIC_XFA: Mapped = {
  wcag: ['1.3.1', '4.1.2'],
  basis:
    'Dynamic XFA content and fields are not expressed in the tagged PDF structure tree, so structure (SC 1.3.1) and the form field name, role and value that PDF12 exposes (SC 4.1.2) are not available to assistive technology through PDF accessibility support.',
};
const REFERENCE_XOBJECT: Mapped = {
  wcag: ['1.3.1'],
  basis:
    'A reference XObject imports content from another file, which is not part of the structure tree of this document, so its structure is not programmatically determinable (SC 1.3.1).',
};

const FORMAT = 'File format rule with no user-facing effect that a WCAG SC addresses.';
const FONT =
  'Font program integrity. Affects rendering and text extraction in general; no W3C PDF technique ties it to a specific SC.';

const MAP: Record<string, Mapped | Unmapped> = {
  '5-1': { reason: 'PDF/UA identification in XMP metadata. ' + FORMAT },
  '5-2': { reason: 'PDF/UA identification in XMP metadata. ' + FORMAT },
  '5-3': { reason: 'PDF/UA identification in XMP metadata. ' + FORMAT },
  '5-4': { reason: 'PDF/UA identification in XMP metadata. ' + FORMAT },
  '5-5': { reason: 'PDF/UA identification in XMP metadata. ' + FORMAT },
  '6.1-1': { reason: 'File header syntax. ' + FORMAT },
  '6.2-1': TAGGED,
  '7.1-1': ARTIFACT,
  '7.1-2': ARTIFACT,
  '7.1-3': ARTIFACT,
  '7.1-4': { reason: 'Suspects flag in MarkInfo. ' + FORMAT },
  '7.1-5': ROLE_MAP,
  '7.1-6': ROLE_MAP,
  '7.1-7': ROLE_MAP,
  '7.1-8': {
    reason:
      'Presence of the catalog Metadata stream. ' + FORMAT + ' The title in it is rule 7.1-9.',
  },
  '7.1-9': TITLE,
  '7.1-10': TITLE,
  '7.1-11': TAGGED,
  '7.1-12': TAGGED,
  '7.2-2': LANG,
  '7.2-3': TABLE,
  '7.2-4': TABLE,
  '7.2-5': TABLE,
  '7.2-6': TABLE,
  '7.2-7': TABLE,
  '7.2-8': TABLE,
  '7.2-9': TABLE,
  '7.2-10': TABLE,
  '7.2-11': TABLE,
  '7.2-12': TABLE,
  '7.2-13': TABLE,
  '7.2-14': TABLE,
  '7.2-15': TABLE,
  '7.2-16': TABLE,
  '7.2-17': LIST,
  '7.2-18': LIST,
  '7.2-19': LIST,
  '7.2-20': LIST,
  '7.2-21': LANG,
  '7.2-22': LANG,
  '7.2-23': LANG,
  '7.2-24': LANG,
  '7.2-25': LANG,
  '7.2-26': TOC,
  '7.2-27': TOC,
  '7.2-28': TOC,
  '7.2-29': LANG,
  '7.2-30': LANG,
  '7.2-31': LANG,
  '7.2-32': LANG,
  '7.2-33': LANG,
  '7.2-34': LANG,
  '7.2-36': TABLE,
  '7.2-37': TABLE,
  '7.2-38': TABLE,
  '7.2-39': TABLE,
  '7.2-40': LIST,
  '7.2-41': TABLE,
  '7.2-42': TABLE,
  '7.2-43': TABLE,
  '7.3-1': FIGURE_ALT,
  '7.4.2-1': HEADING,
  '7.4.4-1': HEADING,
  '7.4.4-2': HEADING,
  '7.4.4-3': HEADING,
  '7.5-1': TABLE,
  '7.5-2': TABLE,
  '7.7-1': FORMULA_ALT,
  '7.9-1': NOTE_ID,
  '7.9-2': NOTE_ID,
  '7.10-1': { reason: 'Optional content configuration Name entry. ' + FORMAT },
  '7.10-2': { reason: 'Optional content configuration AS key. ' + FORMAT },
  '7.11-1': { reason: 'Embedded file specification keys. ' + FORMAT },
  '7.15-1': DYNAMIC_XFA,
  '7.16-1': AT_PERMISSION,
  '7.18.1-1': ANNOT_TAGGED,
  '7.18.1-2': ANNOT_ALT,
  '7.18.1-3': FIELD_NAME,
  '7.18.2-1': { reason: 'TrapNet annotations are a print production feature. ' + FORMAT },
  '7.18.3-1': TAB_ORDER,
  '7.18.4-1': WIDGET,
  '7.18.4-2': WIDGET,
  '7.18.5-1': LINK_TAGGED,
  '7.18.5-2': LINK_ALT,
  '7.18.6.2-1': { reason: 'Media clip content type (CT) key. ' + FORMAT },
  '7.18.6.2-2': MEDIA_ALT,
  '7.18.8-1': { reason: 'PrinterMark annotations are print production artifacts. ' + FORMAT },
  '7.20-1': REFERENCE_XOBJECT,
  '7.20-2': TAGGED,
  '7.21.3.1-1': { reason: FONT },
  '7.21.3.2-1': { reason: FONT },
  '7.21.3.3-1': { reason: FONT },
  '7.21.3.3-2': { reason: FONT },
  '7.21.3.3-3': { reason: FONT },
  '7.21.4.1-1': { reason: FONT },
  '7.21.4.1-2': { reason: FONT },
  '7.21.4.2-1': { reason: FONT },
  '7.21.4.2-2': { reason: FONT },
  '7.21.5-1': { reason: FONT },
  '7.21.6-1': { reason: FONT },
  '7.21.6-2': { reason: FONT },
  '7.21.6-3': { reason: FONT },
  '7.21.6-4': { reason: FONT },
  '7.21.7-1': UNICODE,
  '7.21.7-2': UNICODE,
  '7.21.8-1': { reason: FONT },
};

const xml = await fetchText(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/${PROFILE}`);
const ids = [
  ...xml.matchAll(/<id specification="ISO_14289_1" clause="([^"]+)" testNumber="(\d+)"\/>/g),
].map((m) => ({ clause: m[1]!, testNumber: Number(m[2]) }));
const ruleCount = (xml.match(/<rule\b/g) ?? []).length;
if (ids.length !== ruleCount) throw new Error(`parsed ${ids.length} ids from ${ruleCount} rules`);

const seen = new Set<string>();
const rules = [];
const unmapped = [];
for (const { clause, testNumber } of ids) {
  const id = `${clause}-${testNumber}`;
  seen.add(id);
  const entry = MAP[id];
  if (!entry) throw new Error(`profile rule ${id} is not classified`);
  if ('wcag' in entry) {
    rules.push({
      id,
      clause,
      testNumber,
      wcag: [...entry.wcag],
      decides: false,
      basis: entry.basis,
    });
  } else {
    unmapped.push({ id, clause, testNumber, reason: entry.reason });
  }
}
const stale = Object.keys(MAP).filter((k) => !seen.has(k));
if (stale.length) throw new Error(`classified ids not in profile: ${stale.join(', ')}`);

console.log(`${ids.length} rules: ${rules.length} mapped, ${unmapped.length} unmapped`);

await writeYaml(
  'verapdf-map.yaml',
  [
    `Source: ${PROFILE} in https://github.com/${REPO} (branch ${BRANCH}) at commit ${COMMIT}.`,
    'Rule id is "<clause>-<testNumber>" as veraPDF reports it for specification "ISO 14289-1:2014"',
    '(the profile names it ISO_14289_1). Mapping basis: W3C PDF techniques PDF1 to PDF23 and the',
    'Matterhorn Protocol 1.1 checkpoints. decides is false for every rule: a PDF/UA pass does not',
    'show that the content meets the SC (for example Alt present is not Alt equivalent).',
    'Regenerate: npm run data:verapdf -w @widedoor/core',
  ],
  {
    meta: {
      sources: [
        `https://github.com/${REPO}/blob/${COMMIT}/${PROFILE}`,
        'https://www.w3.org/WAI/WCAG21/Techniques/#pdf',
        'https://taggedpdfschool.pdfa.org/matterhorn',
      ],
      engine: 'verapdf',
      profile: 'PDF/UA-1',
      specification: 'ISO 14289-1:2014',
      branch: BRANCH,
      commit: COMMIT,
      retrieved: new Date().toISOString().slice(0, 10),
    },
    rules,
    unmapped,
  },
);
