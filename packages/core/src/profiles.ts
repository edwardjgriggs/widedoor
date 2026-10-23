import {
  loadStandardsData,
  type ManualCondition,
  type ManualScope,
  type StandardsData,
  type WcagCriterion,
} from './data.js';
import {
  PROFILE_IDS,
  type PdfDocumentType,
  type ProfileId,
  type StandardId,
} from './profile-ids.js';
import type { AssetKind } from './schema.js';

/*
 * Profiles (spec section 4): which SC apply to each asset kind, which are not
 * applicable and why, and which manual-only items a standard adds. The
 * combined profile keeps one view per standard, so an SC can be not
 * applicable under 508 and applicable under WCAG 2.1 at the same time.
 * Task 0.6 roll-up consumes this object; there is no other applicability source.
 */

export * from './profile-ids.js';

export type ProfileCriterion = Pick<WcagCriterion, 'id' | 'title' | 'level' | 'version'>;

export interface NotApplicableCriterion extends ProfileCriterion {
  /** The 508 provision that grants the exception, for example E205.4. */
  provision: string;
  /** The exception text, verbatim. */
  reason: string;
}

export interface ManualItem {
  /** Section 508 provision id, for example 302.1. */
  id: string;
  title: string;
  /** "product": judged once for the product; "web": per web asset (Chapter 5 software). */
  scope: ManualScope;
  /**
   * When the item applies (every Chapter 5 item has one). If the condition does
   * not hold, a reviewer marks the item not applicable citing `provision`.
   */
  condition?: ManualCondition;
}

export interface StandardView {
  standard: StandardId;
  applicable: ProfileCriterion[];
  notApplicable: NotApplicableCriterion[];
  manual: ManualItem[];
}

export interface AssetProfile {
  standards: StandardView[];
}

export interface Profile {
  id: ProfileId;
  pdfDocumentType: PdfDocumentType;
  assets: Record<AssetKind, AssetProfile>;
}

export interface ProfileOptions {
  pdfDocumentType?: PdfDocumentType;
}

const STANDARDS: Record<ProfileId, StandardId[]> = {
  '508': ['508'],
  wcag21aa: ['wcag21aa'],
  '508+wcag21aa': ['508', 'wcag21aa'],
};

const toCriterion = ({ id, title, level, version }: WcagCriterion): ProfileCriterion => ({
  id,
  title,
  level,
  version,
});

function section508View(
  data: StandardsData,
  asset: AssetKind,
  pdfDocumentType: PdfDocumentType,
): StandardView {
  const e2054 = data.section508.provisions.find((p) => p.id === 'E205.4');
  if (!e2054) throw new Error('section508.yaml has no E205.4');
  const nonWebDocument = asset === 'pdf' && pdfDocumentType === 'non-web';
  const excepted = new Map<string, string>();
  if (nonWebDocument) {
    for (const e of e2054.exceptions ?? []) {
      if (e.appliesTo !== 'non-web-document') continue;
      for (const sc of e.criteria ?? []) excepted.set(sc, e.text);
    }
  }

  const applicable: ProfileCriterion[] = [];
  const notApplicable: NotApplicableCriterion[] = [];
  for (const c of data.wcag.criteria) {
    if (c.version !== '2.0') continue;
    const reason = excepted.get(c.id);
    if (reason) notApplicable.push({ ...toCriterion(c), provision: e2054.id, reason });
    else applicable.push(toCriterion(c));
  }

  const manual = data.section508.provisions.flatMap((p): ManualItem[] => {
    if (!p.manual || (p.manual.scope === 'web' && asset !== 'web')) return [];
    const item: ManualItem = { id: p.id, title: p.title, scope: p.manual.scope };
    if (p.manual.condition) item.condition = { ...p.manual.condition };
    return [item];
  });
  return { standard: '508', applicable, notApplicable, manual };
}

function wcag21View(data: StandardsData): StandardView {
  return {
    standard: 'wcag21aa',
    applicable: data.wcag.criteria.map(toCriterion),
    notApplicable: [],
    manual: [],
  };
}

export function getProfile(id: ProfileId, options: ProfileOptions = {}): Profile {
  const standards = STANDARDS[id];
  if (!standards)
    throw new Error(`unknown profile "${String(id)}"; expected ${PROFILE_IDS.join(', ')}`);
  const pdfDocumentType = options.pdfDocumentType ?? 'non-web';
  const data = loadStandardsData();
  const assetProfile = (asset: AssetKind): AssetProfile => ({
    standards: standards.map((s) =>
      s === '508' ? section508View(data, asset, pdfDocumentType) : wcag21View(data),
    ),
  });
  return { id, pdfDocumentType, assets: { web: assetProfile('web'), pdf: assetProfile('pdf') } };
}

/** The view of one standard for one asset kind. Throws if the profile does not include it. */
export function standardView(
  profile: Profile,
  asset: AssetKind,
  standard: StandardId,
): StandardView {
  const view = profile.assets[asset].standards.find((s) => s.standard === standard);
  if (!view) throw new Error(`profile ${profile.id} does not include standard ${standard}`);
  return view;
}
