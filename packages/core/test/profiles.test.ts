import { describe, expect, it } from 'vitest';
import { getProfile, standardView, type AssetKind, type Profile } from '../src/index.js';

const NON_WEB_DOC_EXCEPTIONS = ['2.4.1', '2.4.5', '3.2.3', '3.2.4'];

const ids = (list: { id: string }[]) => list.map((c) => c.id);

function view(profile: Profile, asset: AssetKind, standard: '508' | 'wcag21aa') {
  return standardView(profile, asset, standard);
}

describe('profiles', () => {
  it('508: SC 2.4.1, 2.4.5, 3.2.3, 3.2.4 are not applicable to a PDF by default', () => {
    const pdf = view(getProfile('508'), 'pdf', '508');
    for (const sc of NON_WEB_DOC_EXCEPTIONS) {
      expect(ids(pdf.applicable)).not.toContain(sc);
      const na = pdf.notApplicable.find((c) => c.id === sc);
      expect(na?.provision).toBe('E205.4');
      expect(na?.reason).toContain('Non-Web documents shall not be required to conform');
    }
    expect(pdf.applicable).toHaveLength(34);
  });

  it('508: SC 4.1.1 is present for web and PDF', () => {
    const p = getProfile('508');
    expect(ids(view(p, 'web', '508').applicable)).toContain('4.1.1');
    expect(ids(view(p, 'pdf', '508').applicable)).toContain('4.1.1');
  });

  it('508 with pdfDocumentType web: the four SC apply to PDFs', () => {
    const pdf = view(getProfile('508', { pdfDocumentType: 'web' }), 'pdf', '508');
    for (const sc of NON_WEB_DOC_EXCEPTIONS) expect(ids(pdf.applicable)).toContain(sc);
    expect(pdf.notApplicable).toEqual([]);
    expect(pdf.applicable).toHaveLength(38);
  });

  it('508: web assets get all 38 WCAG 2.0 A/AA SC', () => {
    const web = view(getProfile('508'), 'web', '508');
    expect(web.applicable).toHaveLength(38);
    expect(web.applicable.every((c) => c.version === '2.0')).toBe(true);
    expect(web.notApplicable).toEqual([]);
  });

  it('wcag21aa: 50 SC for web and PDF, the four SC applicable to PDF', () => {
    const p = getProfile('wcag21aa');
    expect(view(p, 'web', 'wcag21aa').applicable).toHaveLength(50);
    const pdf = view(p, 'pdf', 'wcag21aa');
    expect(pdf.applicable).toHaveLength(50);
    for (const sc of NON_WEB_DOC_EXCEPTIONS) expect(ids(pdf.applicable)).toContain(sc);
    expect(ids(pdf.applicable)).toContain('4.1.1');
    expect(pdf.manual).toEqual([]);
  });

  it('508+wcag21aa keeps applicability per standard', () => {
    const p = getProfile('508+wcag21aa');
    expect(p.assets.pdf.standards.map((s) => s.standard)).toEqual(['508', 'wcag21aa']);
    expect(ids(view(p, 'pdf', '508').notApplicable)).toContain('2.4.1');
    expect(ids(view(p, 'pdf', 'wcag21aa').applicable)).toContain('2.4.1');
  });

  it('criteria carry id, title, level and version', () => {
    const c = view(getProfile('508'), 'web', '508').applicable.find((x) => x.id === '1.4.3');
    expect(c).toEqual({ id: '1.4.3', title: 'Contrast (Minimum)', level: 'AA', version: '2.0' });
  });

  it('508 manual items: Chapters 3 and 6 for every asset, Chapter 5 for web only', () => {
    const p = getProfile('508');
    const web = ids(view(p, 'web', '508').manual);
    const pdf = ids(view(p, 'pdf', '508').manual);
    for (const id of ['302.1', '302.9', '602.3', '603.3']) {
      expect(web).toContain(id);
      expect(pdf).toContain(id);
    }
    for (const id of ['502.3.1', '503.4', '504.2.2']) {
      expect(web).toContain(id);
      expect(pdf).not.toContain(id);
    }
    expect(web).not.toContain('502.1');
    const item = view(p, 'web', '508').manual.find((m) => m.id === '302.1');
    expect(item).toEqual({ id: '302.1', title: 'Without Vision', scope: 'product' });
  });

  it('every Chapter 5 manual item carries a condition citing 501.1, 504.1 or its platform addressee', () => {
    const ch5 = view(getProfile('508'), 'web', '508').manual.filter((m) => /^50[234]\./.test(m.id));
    expect(ch5).toHaveLength(28);
    const platformAddressed = ['502.2.1', '502.3', '502.4'];
    for (const m of ch5) {
      expect(m.condition?.text.length, m.id).toBeGreaterThan(20);
      if (platformAddressed.includes(m.id)) {
        expect(m.condition?.provision, m.id).toBe(m.id);
        expect(m.condition?.text, m.id).toMatch(/platform/i);
      } else if (m.id.startsWith('504.')) {
        expect(m.condition?.provision, m.id).toBe('504.1');
      } else {
        expect(m.condition?.provision, m.id).toBe('501.1');
      }
    }
  });

  it('Chapter 3 and 6 manual items are unconditional', () => {
    const items = view(getProfile('508'), 'pdf', '508').manual;
    expect(items.every((m) => m.condition === undefined)).toBe(true);
  });

  it('rejects an unknown profile id', () => {
    expect(() => getProfile('wcag22aa' as never)).toThrow(/unknown profile/);
  });

  it('standardView throws when the profile lacks the standard', () => {
    expect(() => standardView(getProfile('508'), 'web', 'wcag21aa')).toThrow(/wcag21aa/);
  });
});
