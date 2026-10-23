/** The HTML report style sheet. The UI ships the same rules as a CSS file. */
export const REPORT_STYLE = `
:root { color-scheme: light; --ink: #1b1b1b; --muted: #4a4a4a; --line: #c9c9c9; --bg: #ffffff;
  --panel: #f4f4f2; --fail: #a4161a; --review: #7a4b00; --link: #0b4f9c; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: var(--ink); background: var(--bg); }
header, main, footer { max-width: 60rem; margin: 0 auto; padding: 1rem 1.25rem; }
h1 { font-size: 1.9rem; margin: 0.5rem 0; }
h2 { font-size: 1.45rem; margin-top: 2.5rem; border-bottom: 2px solid var(--line); }
h3 { font-size: 1.2rem; margin: 0 0 0.5rem; }
h4 { font-size: 1.05rem; margin: 0.25rem 0; }
.lead { color: var(--muted); }
.cards, .findings { list-style: none; padding: 0; }
.card, .finding { border: 1px solid var(--line); border-radius: 6px; padding: 1rem; margin: 0 0 1rem;
  background: var(--panel); }
.badges { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 0.5rem; padding: 0; list-style: none; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: 0 0.6rem; font-size: 0.9rem;
  font-weight: 600; }
.fail { color: var(--fail); }
.review { color: var(--review); }
.label { font-weight: 700; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line);
  padding: 0.5rem; margin: 0.5rem 0; font-size: 0.9rem; }
code, .uri { overflow-wrap: anywhere; }
img.shot { max-width: 100%; height: auto; border: 1px solid var(--line); background: var(--bg); }
details { margin-top: 0.5rem; }
summary { cursor: pointer; font-weight: 600; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
caption { text-align: left; font-weight: 700; font-size: 1.1rem; padding: 0.5rem 0; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
thead th { background: var(--panel); }
dt { font-weight: 700; margin-top: 0.75rem; }
dd { margin-left: 0; }
.disclaimer { border: 2px solid var(--ink); padding: 1rem; font-weight: 700; }
a { color: var(--link); }
`;
