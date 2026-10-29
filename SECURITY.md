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

## Abuse contact

If the hosted scanner visited your site and you want it to stop, add this to your robots.txt:

```text
User-agent: Widedoor
Disallow: /
```

For anything else about its traffic, use the contact link on the scanner's `/about-scanner` page (`https://widedoor.fly.dev/about-scanner` once deployed). Report security problems in the scanner itself as above, not through that link.
