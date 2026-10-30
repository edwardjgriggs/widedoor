# The hosted scanner

Widedoor's hosted scanner runs on Fly.io. Anyone can scan one public page and a few pages linked
from it, or upload one PDF. A site owner who proves control of a host can crawl more of it. This
page says how it is built, what it refuses, what it keeps and what it does not cover. The
deploy steps are in [hosted-runbook.md](hosted-runbook.md).

## Architecture

Two Fly apps share one private network (6PN), `widedoor-net`. Both are created on it; an app
cannot join a network later.

- **`widedoor`, the API.** One always-on machine (`fly.toml`, Dockerfile target `hosted`, uid
  10001). It serves the hosted page, the public API and `/about-scanner` on port 8080 behind
  Fly's proxy. A second listener on port 8081 binds the machine's 6PN address only; scan
  machines fetch their job and send their result there, each with its own job token. Jobs,
  reports and verifications live in this machine's memory, so there is exactly one API machine.
  A restart forgets them all.
- **`widedoor-scan`, the scan machines.** No service and no public address; `fly.scan.toml`
  only builds its image (Dockerfile target `scan`). The API creates one machine per job through
  the Machines API (`shared-cpu-2x`, 2048 MB, `auto_destroy`, restart policy `no`, no mounts, no
  services), in the API's own region, from the image pinned by digest
  (`registry.fly.io/widedoor-scan@sha256:...`), and destroys it when the job ends or runs past
  its cap. The API holds a deploy token scoped to `widedoor-scan` only, so the token can never
  touch the API app.
- **The sweep.** The API lists `widedoor-scan`'s machines at start and every 10 minutes. The
  first sweep after a start destroys every scan machine (a fresh API holds no jobs); later
  sweeps destroy those older than the longest cap plus 5 minutes (50 minutes). Each sweep also
  counts machines the API did not create (no `widedoor_role`) and logs them as `foreign=`; it
  never destroys those.
- **The scan machine's entry** (`docker/scan-entry.sh`) runs as root and fails closed. It locks
  Fly's machine API socket (`/.fly/api`) to root, loads the kernel firewall whole with
  `nft -f` (one native nftables ruleset, one transaction) and checks that its drop policies are
  in the kernel, starts the egress proxy as uid 10002 with an empty environment, and runs the
  agent. The agent holds the job token, fetches the job, and runs the scan as uid 10001 with no
  token in its environment. After the scan it kills anything left running as uid 10001.
- **The egress proxy** (`packages/web/src/egress/proxy.ts`) listens on `127.0.0.1:18080`. Every
  request the scan makes (Chromium's page loads and subresources, robots.txt, sitemaps, PDF
  fetches) goes through it. It resolves each host itself, checks every address against the
  policy below, pins the first good answer for the rest of the scan, and connects to that pinned
  address. CONNECT tunnels go to port 443 only. Refusals get one generic body; the host and the
  reason go only to the log.
- **The firewall** (`packages/server/src/hosted/firewall.ts`), one `table inet widedoor` for both
  families. It is native nftables (`meta skuid`, `ct original`) because Fly's kernel has no xt
  owner match: iptables' `-m owner` rules failed to load there (seen 2026-10-29). Every chain
  drops by default. The scan user reaches only the proxy's port on loopback. The proxy's user
  reaches DNS at the resolvers and ports 80 and 443 on public addresses, never a blocked range
  and never the control API. Root reaches the control API and DNS. So even a compromised
  browser has one way out: the proxy.
- **Verify jobs.** A domain verification's DNS TXT check runs on the API (DNS only). Its
  well-known file and meta tag checks run as a verify job: a scan machine like any other, the
  same caps, through the same proxy and firewall, with a 2 minute cap.

The API never fetches a scan target over HTTP. Before it starts a machine it checks the URL
against the egress policy and resolves the host through a fresh pinned resolver; the scan
machine's agent does the robots.txt check.

## SSRF controls

| Control                                                                                                                                                                      | Where                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| http and https only, ports 80 and 443 only, no user name or password in the URL                                                                                              | `checkTarget` in `packages/web/src/egress/policy.ts`, on the API and on every hop |
| Host names: no `localhost`, single-label names or names ending in `.localhost`, `.local`, `.internal`, `.flycast`, `.home.arpa`, `.onion`, `.test`, `.invalid` or `.example` | `checkHostName`, before any DNS lookup                                            |
| DNS resolved server-side; a name with any blocked address in its answer is refused, even if other answers are public                                                         | `PinnedResolver`                                                                  |
| The first good answer is pinned per host for the whole scan, so DNS rebinding cannot swap it                                                                                 | `PinnedResolver`, used by the proxy                                               |
| At most 2,000 distinct host names per scan                                                                                                                                   | `PinnedResolver`                                                                  |
| Every redirect hop and every subresource goes through the proxy and is checked again                                                                                         | the proxy and the hardened Chromium context                                       |
| Chromium does no DNS of its own (`--host-resolver-rules`), no QUIC, no WebRTC UDP outside the proxy                                                                          | `packages/web/src/context.ts`                                                     |
| The kernel drops anything the proxy's user sends to a blocked range                                                                                                          | the scan machine's firewall                                                       |
| The deploy gate: `npm run test:ssrf` must pass before any deploy                                                                                                             | `CLAUDE.md`, CI                                                                   |

Blocked IPv4 ranges:

| Range                                                                                                                 | Reason      |
| --------------------------------------------------------------------------------------------------------------------- | ----------- |
| `0.0.0.0/8`                                                                                                           | unspecified |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`                                                                       | private     |
| `100.64.0.0/10`                                                                                                       | cgnat       |
| `127.0.0.0/8`                                                                                                         | loopback    |
| `169.254.0.0/16`                                                                                                      | link-local  |
| `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4` | reserved    |
| `224.0.0.0/4`                                                                                                         | multicast   |

IPv6 is allowed only in `2000::/3`, global unicast. Everything else is refused, and these ranges
inside or next to it are named:

| Range                                                                                                      | Reason                        |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `::/128`                                                                                                   | unspecified                   |
| `::1/128`                                                                                                  | loopback                      |
| `fe80::/10`                                                                                                | link-local                    |
| `fc00::/7` (Fly's 6PN `fdaa::/16` is inside it)                                                            | private                       |
| `ff00::/8`                                                                                                 | multicast                     |
| `2001::/23`, `2001:db8::/32`, `2002::/16` (6to4), `3fff::/20`, `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64) | reserved                      |
| `::/3`, `4000::/2`, `8000::/1`                                                                             | reserved (outside `2000::/3`) |

An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is judged as the IPv4 address it holds.

Cloud metadata addresses are matched exactly, before the ranges, and logged with reason
`metadata`:

- `169.254.169.254` (AWS, GCP, Azure and others)
- `100.100.100.200` (Alibaba Cloud)
- `fd00:ec2::254` (AWS over IPv6)

Other metadata endpoints (`169.254.170.2`, `fd00:ec2::23`, `fd20:ce::254`, `192.0.0.192`) are
not named, but their ranges block them, with reason `link-local`, `private` or `reserved`.

## Data handling

- Nothing is stored on disk. Jobs, reports and verifications live in the API's memory.
- An uploaded PDF is dropped as soon as the scan machine has fetched it, or when the job ends.
  Its file name goes to the scan machine only and is never logged.
- Reports stay downloadable for 1 hour after the job ends, then they are deleted and the job
  reads `expired`. The job id still answers (with no report) for 24 hours, then it is
  forgotten.
- Queued PDFs and kept reports share a 512 MiB budget, counted exactly: kept reports are held
  as UTF-8 bytes, and an upload is judged at the largest PDF (25 MiB) before its body is read. A
  report that does not fit fails the job rather than pushing another out.
- A scan machine sends back only the JSON report: up to 8 MiB for the open tier, 32 MiB for the
  verified tier; past it the scan fails as too large. The API validates it and builds both
  reports itself; a result that carries HTML is refused. Both reports are measured before they
  are kept, so one that does not fit the budget is never copied. A downloaded HTML report is an
  attachment with a sandboxing CSP.
- Downloads are sent as views of the kept report, 64 KiB at a time, with no copy. At most 2 of
  one job, 2 per client IPv4 /32 or IPv6 /64, 4 per /24 or /48, and 64 in all at once (past any
  of them, 429 with `Retry-After: 10`). Each is cut off at 10 seconds plus 1 second per
  256 KiB, at most 2 minutes, and its socket closed. When a job's reports are dropped (expiry
  or cancel), its open downloads end at once, so no download keeps a dropped report in memory.
- Memory: the API machine has 2048 MiB, with 896 MiB for the V8 heap (`fly.toml`,
  `API_HEAP_MB` in `limits.ts`). The 512 MiB budget, the uploads being read and the raw result
  body are outside the heap (Buffers), so the worst case is the sum: heap 896 + budget 512 +
  4 uploads 200 + one raw verified result body 64 + downloads in flight 4 (64 x 64 KiB) +
  Node and the OS 150, about 1826.1 MiB. One result is in transit at a time. The heap is at least
  1.5 times the peak heap of one near-cap verified result in its worst (two-byte) shape
  (`MEASURED_PEAK_HEAP_MB`, 422 MiB); a unit test checks both rules against `fly.toml`.
- Hosted scans take no screenshots.
- The hosted site takes no site credentials, cookies, headers or API keys, and AI is off.
- The page sets no cookies and uses no localStorage. sessionStorage holds only the verification
  you made in that tab (its id, host and expiry), so a reload keeps it. The verification token is
  shown once and kept in memory only.
- A scan machine is destroyed when its job ends.
- The log holds event names, job ids, scanned host names, block reasons and the client's
  network (an IPv4 /24 or IPv6 /48), never a full URL path or query, a token or a PDF name. A
  verification is logged by a `vref`, a keyed hash, never by its id.

## Limits

| Limit                                             | Value                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Open tier, URL                                    | the page plus up to 5 same-origin pages (6 in all), 10 minute cap                                                                         |
| Open tier, PDF                                    | 1 PDF, up to 25 MiB and 100 pages                                                                                                         |
| Verified tier                                     | up to 200 pages on the verified host, 45 minute cap                                                                                       |
| Verify job                                        | 2 minute cap                                                                                                                              |
| Scans per client network                          | 10 an hour per IPv4 /32 or IPv6 /64, and 30 an hour per IPv4 /24 or IPv6 /48                                                              |
| Verification requests (create and check together) | 30 an hour per /32 or /64, 90 an hour per /24 or /48. A check that needs a machine also takes one scan from the scan limits               |
| Uploads                                           | 4 read at once, 1 per /32 or /64; the body must arrive within 2 minutes                                                                   |
| JSON requests                                     | the body must arrive within 10 seconds                                                                                                    |
| Machines                                          | 3 at once, 20 jobs queued, 30 minutes longest wait in the queue                                                                           |
| Live jobs per client network                      | 1 running and 1 queued per IPv4 /32 or IPv6 /64, 2 in all per /24 or /48; scans and verify jobs alike; past it 429 with `Retry-After: 60` |
| Report size                                       | open tier 8 MiB, verified tier 32 MiB (the JSON report)                                                                                   |
| Jobs per UTC day                                  | 300, verify jobs included; at most 100 of them verify jobs                                                                                |
| Verification check after a failed one             | 60 seconds                                                                                                                                |

The client's network comes from `Fly-Client-IP` only, which Fly's proxy sets. A scan or
verification request without it is refused. An IPv4 address in IPv6 form counts as the IPv4 address.
The per-network live job check comes before any rate token is charged and before any body byte
is read, so a refused request costs the client nothing.

Sizes: the hosted page says "25 MB" and these docs say "25 MiB"; both mean the same
25 x 1024 x 1024 bytes (26,214,400).

The client never picks the tier. A scan is verified-tier only when it names a verification
that is verified, unexpired and for the exact host of the URL.

## Robots and the user agent

The scanner identifies itself as
`Mozilla/5.0 (compatible; Widedoor/<version>; +<contact URL>)`. The API's
`WIDEDOOR_CONTACT_URL` (in `fly.toml`) is the one source of the contact URL: the API links to it
on `/about-scanner` and passes it to every scan machine in the machine's config, next to the
control URL. It is required: the API does not start without it, or with anything but an
https URL, or with its own `/about-scanner` (which would link to itself), and it creates no
machine with anything else. `fly.toml` leaves it unset on purpose; the runbook says how to set
it.

Scans honor robots.txt: the `Widedoor` group, or `*` when there is none. `Crawl-delay` is not
honored; hosted crawls fetch one page at a time instead. A disallowed start URL is refused on the
scan machine before any page loads. A site owner can opt out with:

```text
User-agent: Widedoor
Disallow: /
```

Verification checks do not consult robots.txt. They fetch only two fixed addresses the owner
asked for: `/.well-known/widedoor.txt` and the home page. `/about-scanner` says so.

## Domain verification

A verification covers one exact host: no subdomains, and `www` is a separate host. It is good
for 24 hours from issue, for any number of scans in that time; the per-network scan limit
still applies. Publish the token one of three ways:

| Method          | What to publish                                                                             |
| --------------- | ------------------------------------------------------------------------------------------- |
| DNS TXT         | a TXT record on `_widedoor-challenge.<host>` with the value `widedoor-verification=<token>` |
| Well-known file | `https://<host>/.well-known/widedoor.txt` whose first line, trimmed, is the token           |
| Meta tag        | `<meta name="widedoor-verification" content="<token>">` in the head of `https://<host>/`    |

A check tries DNS first, on the API. If that does not match, a verify job fetches the
well-known file, then the home page. It follows at most 3 redirects, each on the same https
host and port, and waits at most 20 seconds per method. Tokens are not secrets: they end up in
public DNS and HTML, and a token alone lets no one scan anything. The verification id is what
grants the verified tier, and only its creator gets it.

## Known limitations

- **A report download has a throughput floor.** It must finish within 10 seconds plus 1 second
  per 256 KiB (at most 2 minutes), so on links slower than about 2 Mbit/s the largest
  verified-tier HTML report can be cut off. Download the JSON report instead, or use a faster
  link.
- **Self-scan refusal is by name only.** The API refuses its own host, any `*.fly.dev` name and
  any `*.internal` name. It does not refuse the app's anycast IP addresses, or a third-party name
  that points at them. Such a scan reaches only the public routes that anyone can already reach;
  the control listener is on the 6PN, which the firewall keeps the proxy's user out of.
- **The meta tag check walks the head with a small parser**, not a full HTML parser. It does not
  model two rare parse states: a script in its double-escaped state, and a doctype whose quoted
  value holds `<` (which ends the head early in a browser). Both need someone who can already
  edit the page's markup, so they cannot verify a stranger's site.
- **Sites on other ports** cannot be scanned hosted. Use the CLI.
- **Linked PDFs** are not fetched by hosted page scans. Upload the PDF or give its URL.
- **A site that moves mid-scan** fails its later pages: addresses are pinned per scan.
- **A transient DNS failure** refuses that host for the rest of the scan.
- **A restart of the API** forgets every job, report and verification.

## Abuse contact

`/about-scanner` names the scanner's user agent, how to opt out, and a contact link
(`WIDEDOOR_CONTACT_URL`). Report abuse of the hosted scanner there, or as
[SECURITY.md](../SECURITY.md) says.
