import { fetchText, writeYaml } from './lib/write-yaml.ts';

// Builds data/baseline.yaml from the ICT Testing Baseline repository at a
// pinned commit. Each test takes the WCAG SC and Section 508 provisions cited
// inline in its own test instructions ("[SC 1.1.1]", "[Section 508 503.4]").
// Tests whose instructions cite nothing get an explicit entry in OVERRIDES.
const REPO = 'atbcb/ICTTestingBaseline';
const COMMIT = '082e144ef2219bb66ce530018e1e4fb2534352b2';
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/`;

const BASELINES = {
  web: {
    name: 'ICT Testing Baseline for Web',
    version: '3.1',
    dir: '_baselines/web-baselines/',
    file: /^\d\d[A-Za-z-]+\.md$/,
  },
  document: {
    name: 'ICT Testing Baseline for Electronic Documents',
    version: '1.0',
    dir: '_baselines/document-baselines/',
    file: /^\d\d[A-Za-z]+Docs\.md$/,
  },
} as const;

type Override = {
  wcag: string[];
  section508?: string[];
  conformanceRequirement?: number;
  basis: string;
};

// Keyed by test id; applies to both baselines where the id exists in both.
const OVERRIDES: Record<string, Override> = {
  '3.A-NonInterference': {
    wcag: [],
    conformanceRequirement: 5,
    basis: 'Test cites [CR5] only: WCAG Conformance Requirement 5 (Non-Interference).',
  },
  '16.C-AudioMediaAlternative': {
    wcag: ['1.2.1'],
    basis:
      'Decides whether audio-only content is a media alternative for text, the exception in SC 1.2.1 (the only SC in this section).',
  },
  '16.D-VideoMediaAlternative': {
    wcag: ['1.2.1'],
    basis:
      'Decides whether video-only content is a media alternative for text, the exception in SC 1.2.1 (the only SC in this section).',
  },
  '17.G-SyncMediaAlternative': {
    wcag: ['1.2.2', '1.2.3'],
    basis:
      'Decides whether synchronized media is a media alternative for text; SC 1.2.2 and 1.2.3 carry that exception.',
  },
  '20.A-ConformingAltVersion': {
    wcag: [],
    conformanceRequirement: 1,
    basis: 'Section cites WCAG Conformance Requirement 1 (conforming alternate version).',
  },
  '24.A-Parsing': {
    wcag: ['4.1.1'],
    basis: 'Section cites SC 4.1.1 only; the test is "No testing necessary" and always passes.',
  },
};

type Test = {
  id: string;
  baseline: keyof typeof BASELINES;
  title: string;
  wcag: string[];
  section508?: string[];
  conformanceRequirement?: number;
  notApplicable?: string;
  basis?: string;
};

const tree = (await (
  await fetch(`https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`)
).json()) as { tree: { path: string; type: string }[] };

const tests: Test[] = [];
for (const [baseline, cfg] of Object.entries(BASELINES) as [
  keyof typeof BASELINES,
  (typeof BASELINES)[keyof typeof BASELINES],
][]) {
  const files = tree.tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(cfg.dir))
    .map((t) => t.path.slice(cfg.dir.length))
    .filter((f) => cfg.file.test(f))
    .sort();
  for (const f of files) {
    const text = await fetchText(RAW + cfg.dir + f);
    for (const part of text.split(/^(?=### )/m)) {
      const id = part.match(/\*\*Baseline Test ID:\*\*\s*([^\s<]+)/)?.[1];
      if (!id) continue;
      const heading = part.split('\n')[0]!.replace(/^###\s*/, '');
      const na = heading.match(/\s+--\s+(Not applicable to documents)\s*$/i);
      const title = heading
        .replace(/\s+--\s+.*$/, '')
        .replace(/^\d+\.[A-Z]\s+(?:for\s+)?Test Procedure for\s+/i, '')
        .trim();
      const wcag = new Set<string>();
      for (const m of part.matchAll(/\[SC ([^\]]+)\]/g)) {
        for (const sc of m[1]!.match(/\d\.\d{1,2}\.\d{1,2}/g) ?? []) wcag.add(sc);
      }
      const s508 = new Set<string>();
      for (const m of part.matchAll(/\[Section 508 ([^\]]+)\]/g)) {
        for (const p of m[1]!.match(/\d{3}(?:\.\d+)*/g) ?? []) s508.add(p);
      }
      const test: Test = { id, baseline, title, wcag: [...wcag] };
      if (s508.size) test.section508 = [...s508];
      if (na) {
        test.notApplicable = na[1]!;
      } else if (!wcag.size && !s508.size) {
        const o = OVERRIDES[id];
        if (!o)
          throw new Error(`${cfg.dir}${f}: ${id} cites no SC or provision and has no override`);
        test.wcag = o.wcag;
        if (o.section508) test.section508 = o.section508;
        if (o.conformanceRequirement) test.conformanceRequirement = o.conformanceRequirement;
        test.basis = o.basis;
      }
      tests.push(test);
    }
  }
}

for (const b of Object.keys(BASELINES)) {
  console.log(`${b}: ${tests.filter((t) => t.baseline === b).length} tests`);
}

await writeYaml(
  'baseline.yaml',
  [
    `Source: https://github.com/${REPO} at commit ${COMMIT}.`,
    'Content by the Federal CIO Council Accessibility Community of Practice (ACOP); see NOTICE.',
    'Ids are the published "Baseline Test ID" values. Regenerate: npm run data:baseline -w @widedoor/core',
  ],
  {
    meta: {
      sources: [`https://github.com/${REPO}/tree/${COMMIT}/_baselines`],
      commit: COMMIT,
      retrieved: new Date().toISOString().slice(0, 10),
      baselines: Object.fromEntries(
        Object.entries(BASELINES).map(([k, v]) => [k, { name: v.name, version: v.version }]),
      ),
    },
    tests,
  },
);
