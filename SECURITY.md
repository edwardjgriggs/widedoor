# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting once this repository is public. Until then there is no public reporting channel, and the project accepts no outside reports.

Please do not open public issues for security problems.

## Supported versions

No versions have been released. Nothing is supported yet.

## Hosted scanner

The hosted scanner (`packages/server/src/hosted`, the Dockerfile targets `scan` and `hosted`, and `fly.toml`; see [docs/hosted.md](docs/hosted.md)) is in scope once it is deployed, including:

- any way to make a scan reach a private, loopback, link-local, CGNAT, multicast or cloud metadata address, Fly's private network, or the API's control listener;
- any way out of a scan machine's lockdown (the egress proxy, the firewall, the scan user);
- any way to get another person's report, verification or job token, or the API's Fly token;
- any way to get the verified tier for a host you do not control.

Load tests and denial of service against the hosted scanner are out of scope; please do not run them.

The hosted scanner has no AI: its API, agent and images never load the AI code, and its API answers no AI request.

## AI fix suggestions

AI fix suggestions (`packages/ai`, `--ai-fixes`, `widedoor suggest` and `widedoor ui`; see [docs/ai-fixes.md](docs/ai-fixes.md)) are in scope, including:

- any way to make the provider key appear in a log, an error, a report, the suggestions files, an HTTP response or an MCP result, or reach a child process (veraPDF, Docker, Chromium, a browser `widedoor ui` opens). Keys come from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment only;
- any way to make a request carry the page URL, a host, a form value, a query string, PDF text or a manual review note, past the redactor;
- any way for scanned content or a model answer to cause a second request, a file write, a fetch, a clickable link, executed markup, or a change to a report or an exit code.

Provider traffic is the only outbound traffic the feature adds, and only when the user turns it on.

## The MCP server

`widedoor mcp` (see [docs/mcp.md](docs/mcp.md)) is in scope, including:

- any tool call that reads or writes a path outside its root folder (`--root`), through a link, a junction, `..`, a drive-relative or a UNC path;
- any way, without `--allow-local`, to make a scan reach localhost, a private, link-local or metadata address, directly or by a redirect;
- any way to pass credentials (a storage state, headers or cookies) through a tool call;
- any text from a scanned page, a PDF or a report file that reaches a tool result outside `untrustedPageContent`.

A client steered by page text can still ask for a public scan of an attacker's URL carrying data from its own context; that is a known limit, described in [docs/mcp.md](docs/mcp.md).

## Abuse contact

If the hosted scanner visited your site and you want it to stop, add this to your robots.txt:

```text
User-agent: Widedoor
Disallow: /
```

For anything else about its traffic, use the contact link on the scanner's `/about-scanner` page (`https://widedoor.fly.dev/about-scanner` once deployed). Report security problems in the scanner itself as above, not through that link.
