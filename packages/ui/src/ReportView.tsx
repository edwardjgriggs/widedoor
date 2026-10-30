import { Fragment, type ReactNode } from 'react';
import type { Finding } from '@widedoor/core/browser';
import {
  DISCLAIMER,
  EXPIRED_NOTE,
  IMPACT_LABEL,
  IMPACT_ORDER,
  MAX_SKIPPED_LISTED,
  STANDARD_LABEL,
  TEXT,
  assetCounts,
  assetFindings,
  assetKindText,
  attachmentAgainText,
  attachmentLeftOut,
  axeRuleUrl,
  cardBadges,
  cardHeading,
  checklistRows,
  conditionText,
  crawlText,
  datesText,
  engineName,
  engineText,
  errorText,
  exceptionNotes,
  exceptionText,
  findingCards,
  findingHeading,
  findingPlace,
  informationalText,
  leadText,
  levelsText,
  manualReviews,
  moreSkippedText,
  notEvaluated,
  notTestedText,
  aiSuggestable,
  overriddenFails,
  overrideEntries,
  overrideNotes,
  overrideText,
  plainFor,
  profileText,
  recordText,
  restsOnErrata,
  reviewerText,
  smallScreenText,
  summarize,
  summaryRows,
  understandingUrl,
  unscannedAssets,
  unscannedReviewText,
  visibleText,
  type Criterion,
  type FindingCard,
  type OverrideTest,
  type ScanReport,
} from '@widedoor/report/browser';
import { NO_ATTACHMENTS, NO_EVIDENCE, type ScreenshotView, type UiData } from './data.js';

/*
 * The report as the HTML report shows it, with the same sections, wording and
 * order: every fixed sentence comes from the report package's view module,
 * and test/render.test.tsx compares the two renderings. React renders text
 * only, and every value goes through t(), which shows invisible and bidi
 * characters as [U+XXXX] markers exactly as the HTML report does. Links are
 * built from mapping data, never from scanned content, and only http(s)
 * links render.
 */

const t = (value: unknown) => visibleText(value);

type Skipped = ScanReport['skipped'][number];
type Standard = ScanReport['rollup']['standards'][number];

export interface ReportViewProps {
  report: ScanReport;
  data: UiData;
  screenshots: ReadonlyMap<string, ScreenshotView>;
  /** Review attachments the server loaded, by the path their record names; none for a file. */
  attachments?: ReadonlyMap<string, ScreenshotView>;
  /** The findings to list in the cards and per-asset sections; all of them when not filtered. */
  findings?: readonly Finding[];
  /**
   * Given only when AI fix suggestions are available for this report: each
   * automated fail no reviewer overrode (aiSuggestable) gets a "Suggest a
   * fix (AI)" button. The HTML report has no such button, so render.test.tsx
   * renders without it.
   */
  onSuggest?: (finding: Finding) => void;
  /** The "Suggest a fix (AI)" buttons are disabled while a suggestion is being prepared, confirmed or run. */
  suggestDisabled?: boolean;
}

const isWebUrl = (href: string) => {
  try {
    const { protocol } = new URL(href);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

/** The only place a link is rendered. */
function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  // eslint-disable-next-line no-restricted-syntax -- the one checked link renderer
  return isWebUrl(href) ? <a href={href}>{children}</a> : <>{children}</>;
}

const Uri = ({ value }: { value: string }) => <span className="uri">{t(value)}</span>;

/** A list of items, one per line, or the fallback text when there are none. */
function List({ items, fallback = TEXT.none }: { items: ReactNode[]; fallback?: string }) {
  if (items.length === 0) return <>{fallback}</>;
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function StandardsAndRule({
  data,
  f,
  wcag,
  s508,
}: {
  data: UiData;
  f: Finding;
  wcag: Iterable<string>;
  s508: Iterable<string>;
}) {
  const { engine, ruleId, engineVersion } = f.source;
  const items: ReactNode[] = [];
  for (const id of wcag) {
    const title = data.wcagTitle.get(id);
    items.push(
      title ? (
        <>
          WCAG{' '}
          <SafeLink href={understandingUrl(title)}>
            {t(id)} {t(title)}
          </SafeLink>
        </>
      ) : (
        <>WCAG {t(id)}</>
      ),
    );
  }
  for (const id of s508)
    items.push(
      <>
        Section 508 {t(id)} {t(data.provisionTitle.get(id) ?? '')}
      </>,
    );
  if (f.criteria.baselineTest)
    items.push(<>ICT Testing Baseline test {t(f.criteria.baselineTest)}</>);
  const rule =
    engine === 'axe-core' ? (
      <SafeLink href={axeRuleUrl(ruleId, engineVersion)}>{t(ruleId)}</SafeLink>
    ) : (
      t(ruleId)
    );
  items.push(
    <>
      Rule: {t(engineName(engine))} {t(engineVersion)}, {rule}
    </>,
  );
  if (f.source.actRuleId) items.push(<>W3C ACT rule {t(f.source.actRuleId)}</>);
  return (
    <details>
      <summary>{TEXT.standardsAndRule}</summary>
      <List items={items} />
    </details>
  );
}

function Card({ c, data }: { c: FindingCard; data: UiData }) {
  const p = plainFor(c.first, data.plain);
  const b = cardBadges(c);
  return (
    <li className="card">
      <h3>{t(cardHeading(c, p))}</h3>
      <ul className="badges">
        <li className="badge">{b.impact}</li>
        {b.fails && <li className="badge fail">{b.fails}</li>}
        {b.reviews && <li className="badge review">{b.reviews}</li>}
        <li className="badge">{b.assets}</li>
      </ul>
      {p && (
        <>
          <p>
            <span className="label">{TEXT.whoAffects}</span> {t(p.who)}
          </p>
          <p>
            <span className="label">{TEXT.howToFix}</span> {t(p.fix)}
          </p>
        </>
      )}
      <StandardsAndRule data={data} f={c.first} wcag={c.wcag} s508={c.section508} />
    </li>
  );
}

function Cards({
  findings,
  assets,
  data,
  filtered,
  overridden,
}: {
  findings: readonly Finding[];
  assets: ScanReport['assets'];
  data: UiData;
  filtered: boolean;
  overridden: OverrideTest;
}) {
  const cards = findingCards(findings, assets, overridden);
  if (cards.length === 0)
    return filtered ? (
      <p>No findings match the filter.</p>
    ) : (
      <p>{assets.length === 0 ? TEXT.nothingScanned : TEXT.noFindings}</p>
    );
  return (
    <ol className="cards">
      {cards.map((c) => (
        <Card key={`${c.engine}\u0000${c.ruleId}`} c={c} data={data} />
      ))}
    </ol>
  );
}

function FindingItem({
  f,
  data,
  screenshots,
  onSuggest,
  suggestDisabled,
}: {
  f: Finding;
  data: UiData;
  screenshots: ReadonlyMap<string, ScreenshotView>;
  onSuggest?: ((finding: Finding) => void) | undefined;
  suggestDisabled?: boolean | undefined;
}) {
  const p = plainFor(f, data.plain);
  const viewport = f.evidence?.viewport;
  const snippet = f.evidence?.snippet;
  const shot = f.evidence?.screenshot;
  const image = shot === undefined ? undefined : (screenshots.get(shot) ?? NO_EVIDENCE);
  return (
    <li className="finding">
      <ul className="badges">
        {f.outcome === 'fail' ? (
          <li className="badge fail">{TEXT.problem}</li>
        ) : (
          <li className="badge review">{TEXT.checkByHand}</li>
        )}
        <li className="badge">{IMPACT_LABEL[f.impact ?? 'unrated']}</li>
      </ul>
      <h4>{t(findingHeading(f, p))}</h4>
      <p>{t(findingPlace(f))}</p>
      {viewport && <p>{smallScreenText(viewport)}</p>}
      {snippet && (
        <pre>
          <code>{t(snippet)}</code>
        </pre>
      )}
      {image &&
        (image.ok ? (
          // eslint-disable-next-line no-restricted-syntax -- a data:image/png URI checked by ScreenshotsSchema
          <img className="shot" src={image.dataUri} alt={TEXT.screenshotAlt} />
        ) : (
          <p>Screenshot left out: {t(image.reason)}.</p>
        ))}
      <StandardsAndRule
        data={data}
        f={f}
        wcag={f.criteria.wcag ?? []}
        s508={f.criteria.section508 ?? []}
      />
      {onSuggest && f.outcome === 'fail' && (
        <div className="actions">
          <button type="button" onClick={() => onSuggest(f)} disabled={suggestDisabled === true}>
            Suggest a fix (AI)
            <span className="visually-hidden">: {t(findingHeading(f, p))}</span>
          </button>
        </div>
      )}
    </li>
  );
}

// pdf-url: reports written before PDFs were fetched by URL.
const skipNote = (s: Skipped) =>
  s.reason === 'pdf-url' ? (
    TEXT.pdfUrlSkip
  ) : s.reason === 'robots-unchecked' ? (
    TEXT.robotsUncheckedSkip
  ) : s.reason === 'robots-unreachable' ? (
    TEXT.robotsUnreachableSkip
  ) : s.reason === 'robots-disallowed' ? (
    TEXT.robotsSkip
  ) : (
    <>
      Not scanned: it went to <Uri value={s.finalUri} /> ({t(s.reason)})
    </>
  );

const skipItem = (s: Skipped) =>
  s.reason === 'pdf-url' ? (
    <>
      <Uri value={s.uri} />
      {TEXT.pdfUrlItem}
    </>
  ) : s.reason === 'robots-unchecked' ? (
    <>
      <Uri value={s.uri} />
      {TEXT.robotsUncheckedItem}
    </>
  ) : s.reason === 'robots-unreachable' ? (
    <>
      <Uri value={s.uri} />
      {TEXT.robotsUnreachableItem}
    </>
  ) : s.reason === 'robots-disallowed' ? (
    <>
      <Uri value={s.uri} />
      {TEXT.robotsItem}
    </>
  ) : (
    <>
      <Uri value={s.uri} /> went to <Uri value={s.finalUri} /> ({t(s.reason)})
    </>
  );

function Assets({
  report,
  data,
  screenshots,
  findings,
  filtered,
  overridden,
  onSuggest,
  suggestDisabled,
}: Omit<Required<ReportViewProps>, 'attachments' | 'onSuggest' | 'suggestDisabled'> & {
  filtered: boolean;
  overridden: OverrideTest;
  onSuggest?: ((finding: Finding) => void) | undefined;
  suggestDisabled?: boolean | undefined;
}) {
  const titles = new Map(report.titles.map((x) => [x.uri, x.title]));
  const { unscanned, skippedOver } = unscannedAssets(report);
  // Only where a run would send something: not on a manual fail or an overridden one.
  const suggestable = aiSuggestable(overridden);
  if (report.assets.length === 0 && unscanned.length === 0) return <p>{TEXT.noAssets}</p>;
  const section = (uri: string, kind: string, i: number, note?: ReactNode) => {
    // The counts describe the page, so they come from every finding, not the filtered list.
    const all = assetFindings(report.findings, uri, report.assets, overridden);
    const found = filtered ? assetFindings(findings, uri, report.assets, overridden) : all;
    const body =
      note !== undefined && all.length === 0 ? null : found.length > 0 ? (
        <ol className="findings">
          {found.map((f, j) => (
            <FindingItem
              key={j}
              f={f}
              data={data}
              screenshots={screenshots}
              onSuggest={suggestable(f) ? onSuggest : undefined}
              suggestDisabled={suggestDisabled}
            />
          ))}
        </ol>
      ) : all.length > 0 ? (
        <p>No findings match the filter.</p>
      ) : (
        <p>{TEXT.nothingHere}</p>
      );
    const id = `asset-${i + 1}`;
    const title = titles.get(uri);
    // Named by title and URI: pages often share a title, and each landmark needs its own name.
    return (
      <section key={id} aria-labelledby={title === undefined ? id : `${id} ${id}-uri`}>
        {title === undefined ? (
          <h3 id={id} className="uri">
            {t(uri)}
          </h3>
        ) : (
          <>
            <h3 id={id}>{title === '' ? TEXT.emptyTitle : t(title)}</h3>
            <p className="uri" id={`${id}-uri`}>
              {t(uri)}
            </p>
          </>
        )}
        <p className="lead">
          {assetKindText(kind)}. {note ?? assetCounts(all)}
        </p>
        {filtered && all.length > 0 && (
          <p>
            The filter shows {found.length} of {all.length}.
          </p>
        )}
        {body}
      </section>
    );
  };
  return (
    <>
      {report.assets.map((a, i) => section(a.uri, a.kind, i))}
      {unscanned.map((u, i) =>
        section(
          u.uri,
          u.kind,
          report.assets.length + i,
          'error' in u ? (
            <>
              Not scanned ({t(u.error.code)}): {t(u.error.message)}
            </>
          ) : (
            skipNote(u.skip)
          ),
        ),
      )}
      {skippedOver > 0 && <p>{moreSkippedText(skippedOver)}</p>}
    </>
  );
}

function Summary({ report }: { report: ScanReport }) {
  const s = summarize(report);
  const h = TEXT.summary;
  const row = (label: string, ...cells: number[]) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      {cells.map((c, i) => (
        <td key={i}>{c}</td>
      ))}
    </tr>
  );
  return (
    <>
      <table>
        <caption>{h.counts}</caption>
        <thead>
          <tr>
            <th scope="col">{h.what}</th>
            <th scope="col">{h.number}</th>
          </tr>
        </thead>
        <tbody>{summaryRows(s).map(([label, n]) => row(label, n))}</tbody>
      </table>
      <table>
        <caption>{h.byImpact}</caption>
        <thead>
          <tr>
            <th scope="col">{h.impact}</th>
            <th scope="col">{h.problems}</th>
            <th scope="col">{h.toCheck}</th>
          </tr>
        </thead>
        <tbody>
          {IMPACT_ORDER.map((i) =>
            row(IMPACT_LABEL[i], s.failsByImpact[i], s.needsReviewByImpact[i]),
          )}
        </tbody>
      </table>
      {s.criteria.map((c, i) => (
        <p key={i}>{t(levelsText(c))}</p>
      ))}
    </>
  );
}

/** Progress of the manual review checklist and the fails reviewers set aside. */
function Manual({ report }: { report: ScanReport }) {
  const { checklist } = report;
  const m = TEXT.manual;
  const overrides = overrideEntries(report).map((o) => (
    <>
      {t(overrideText(o))}
      <Uri value={o.uri} />
      {t(overrideNotes(o))}
    </>
  ));
  return (
    <>
      <p>{m.lead}</p>
      {checklist ? (
        <>
          <table>
            <caption>{m.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{m.status}</th>
                <th scope="col">{m.items}</th>
              </tr>
            </thead>
            <tbody>
              {checklistRows(checklist).map(([label, n]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {checklist.unscanned > 0 && <p>{unscannedReviewText(checklist.unscanned)}</p>}
        </>
      ) : (
        <p>{m.noChecklist}</p>
      )}
      <h3 id="overridden">{TEXT.heading.overridden}</h3>
      <p>{m.overriddenLead}</p>
      {overrides.length > 0 ? <List items={overrides} /> : <p>{m.noOverrides}</p>}
    </>
  );
}

/** The images a review record names, as the server loaded them, or why one is left out. */
function Attachments({
  items,
  attachments,
}: {
  /** Each path, and whether an earlier record already named it (it is then only pointed to). */
  items: readonly { path: string; again: boolean }[];
  attachments: ReadonlyMap<string, ScreenshotView>;
}) {
  return (
    <>
      {items.map(({ path, again }, i) => {
        if (again) return <p key={i}>{t(attachmentAgainText(path))}</p>;
        const image = attachments.get(path) ?? NO_ATTACHMENTS;
        return image.ok ? (
          // eslint-disable-next-line no-restricted-syntax -- a data:image/png or jpeg URI checked by AttachmentsSchema
          <img key={i} className="shot" src={image.dataUri} alt={TEXT.attachmentAlt} />
        ) : (
          <p key={i}>{t(attachmentLeftOut(path, image.reason))}</p>
        );
      })}
    </>
  );
}

/**
 * The level's reason, plus the applicability condition, any profile exception (spec section 4)
 * and, for a criterion that passes on the errata basis, links to the errata.
 */
function Why({ c, data }: { c: Criterion; data: UiData }) {
  const notes: ReactNode[] = [t(c.reason)];
  if (c.condition) notes.push(t(conditionText(c.condition)));
  for (const e of exceptionNotes(c)) notes.push(t(exceptionText(e)));
  // As in the HTML report: only https citation links.
  const errata = (restsOnErrata(c) ? (data.errata.get(c.id) ?? []) : []).filter((e) =>
    /^https:\/\//.test(e.url),
  );
  if (errata.length > 0)
    notes.push(
      <>
        {TEXT.errataBasis}{' '}
        {errata.map((e, i) => (
          <Fragment key={i}>
            {i > 0 && '; '}
            <SafeLink href={e.url}>{t(e.name)}</SafeLink>
          </Fragment>
        ))}
      </>,
    );
  return (
    <>
      {notes.map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {n}
        </Fragment>
      ))}
    </>
  );
}

function RollupTable({ s, data }: { s: Standard; data: UiData }) {
  return (
    <table>
      <caption>{t(STANDARD_LABEL[s.standard] ?? s.standard)}</caption>
      <thead>
        <tr>
          {TEXT.rollupColumns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {s.criteria.map((c, i) => (
          <tr key={i}>
            <th scope="row">{t(c.id)}</th>
            <td>{t(c.title)}</td>
            <td>{t(c.level)}</td>
            <td>
              <Why c={c} data={data} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Methodology({
  report,
  attachments,
}: {
  report: ScanReport;
  attachments: ReadonlyMap<string, ScreenshotView>;
}) {
  const { web, pdf } = report.scope;
  const m = TEXT.method;
  const scope: ReactNode[] = [
    ...(web?.urls ?? []).map((u) => (
      <>
        Web page: <Uri value={u} />
      </>
    )),
    ...(web?.sitemap !== undefined
      ? [
          <>
            Sitemap: <Uri value={web.sitemap} />
          </>,
        ]
      : []),
    ...(web?.crawl ? [t(crawlText(web.crawl))] : []),
    ...(web?.truncated ? [TEXT.truncated] : []),
    ...(pdf?.files ?? []).map((u) => (
      <>
        PDF: <Uri value={u} />
      </>
    )),
    ...(pdf?.include ?? []).map((u) => (
      <>
        PDFs matching: <Uri value={u} />
      </>
    )),
    ...(pdf?.urls ?? []).map((u) => (
      <>
        PDF by URL: <Uri value={u} />
      </>
    )),
  ];
  const untested = notEvaluated(report).map((u) => t(notTestedText(u)));
  const { reviewers, records: reviews } = manualReviews(report);
  // As in the HTML report, each attachment is embedded once, at the first record that names it.
  const seen = new Set<string>();
  const records = reviews.map((r) => {
    const items = r.attachments.map((path) => {
      const again = seen.has(path);
      seen.add(path);
      return { path, again };
    });
    return (
      <>
        {t(recordText(r))}
        <Uri value={r.uri} />
        {r.expired ? EXPIRED_NOTE : ''}
        {r.notes ? <>. Notes: {t(r.notes)}</> : ''}
        <Attachments items={items} attachments={attachments} />
      </>
    );
  });
  const people = reviewers.map((p) => t(reviewerText(p)));
  const engines = report.engines.map((e) => t(engineText(e)));
  const errors = report.errors.map((e) => (
    <>
      <Uri value={e.uri} />
      {t(errorText(e))}
    </>
  ));
  const skipped: ReactNode[] = [
    ...report.skipped.slice(0, MAX_SKIPPED_LISTED).map(skipItem),
    ...(report.skipped.length > MAX_SKIPPED_LISTED
      ? [moreSkippedText(report.skipped.length - MAX_SKIPPED_LISTED)]
      : []),
  ];
  return (
    <dl>
      <dt>{m.tool}</dt>
      <dd>Widedoor {t(report.tool.version)}</dd>
      <dt>{m.engines}</dt>
      <dd>
        <List items={engines} />
      </dd>
      <dt>{m.profile}</dt>
      <dd>{t(profileText(report))}</dd>
      <dt>{m.dates}</dt>
      <dd>{t(datesText(report))}</dd>
      <dt>{m.scope}</dt>
      <dd>
        <List items={scope} />
      </dd>
      <dt>{m.notTested}</dt>
      <dd>
        <p>{TEXT.notTestedLead}</p>
        <List items={untested} />
      </dd>
      <dt>{m.reviewers}</dt>
      <dd>
        <List items={people} fallback={TEXT.noReviewers} />
      </dd>
      <dt>{m.records}</dt>
      <dd>
        <List items={records} />
      </dd>
      <dt>{m.errors}</dt>
      <dd>
        <List items={errors} />
      </dd>
      <dt>{m.skipped}</dt>
      <dd>
        <List items={skipped} />
      </dd>
      <dt>{m.warnings}</dt>
      <dd>
        <List items={report.warnings.map(t)} />
      </dd>
      {report.informational.length > 0 && (
        <>
          <dt>{m.informational}</dt>
          <dd>{informationalText(report.informational.length)}</dd>
        </>
      )}
    </dl>
  );
}

/** The lead line under the page heading. */
export const reportLead = (report: ScanReport): string => t(leadText(report));

/** Every report section, in the HTML report's order. */
export function ReportView({
  report,
  data,
  screenshots,
  attachments = new Map(),
  findings,
  onSuggest,
  suggestDisabled,
}: ReportViewProps) {
  const shownFindings = findings ?? report.findings;
  const filtered = findings !== undefined;
  const overridden = overriddenFails(report);
  const h = TEXT.heading;
  return (
    <>
      <section aria-labelledby="manual">
        <h2 id="manual">{h.manual}</h2>
        <Manual report={report} />
      </section>
      <section aria-labelledby="fix">
        <h2 id="fix">{h.fix}</h2>
        <Cards
          findings={shownFindings}
          assets={report.assets}
          data={data}
          filtered={filtered}
          overridden={overridden}
        />
      </section>
      <section aria-labelledby="by-asset">
        <h2 id="by-asset">{h.byAsset}</h2>
        <Assets
          report={report}
          data={data}
          screenshots={screenshots}
          findings={shownFindings}
          filtered={filtered}
          overridden={overridden}
          onSuggest={onSuggest}
          suggestDisabled={suggestDisabled}
        />
      </section>
      <section aria-labelledby="summary">
        <h2 id="summary">{h.summary}</h2>
        <Summary report={report} />
      </section>
      <section aria-labelledby="rollup">
        <h2 id="rollup">{h.rollup}</h2>
        {report.rollup.standards.map((s, i) => (
          <RollupTable key={i} s={s} data={data} />
        ))}
      </section>
      <section aria-labelledby="method">
        <h2 id="method">{h.method}</h2>
        <Methodology report={report} attachments={attachments} />
      </section>
      <section aria-labelledby="disclaimer">
        <h2 id="disclaimer">{h.disclaimer}</h2>
        <p className="disclaimer">{DISCLAIMER}</p>
      </section>
    </>
  );
}
