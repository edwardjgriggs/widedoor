# Hosted scanner runbook

Every command Edward runs to deploy and operate the hosted scanner on Fly.io, in order. Every
command that touches Fly is marked **Needs Edward's OK**: nothing here runs on its own, and no
task in the repo runs `fly`. Commands are for PowerShell from the repo root, except the token
steps, which are for Git Bash (section 3 says why). `<org>`, `<label>`, `<digest>`, `<id>` and
the like are placeholders.

Fly facts behind this runbook were checked against Fly's docs on 2026-10-28. Where a fact is
not confirmed by the docs, this runbook says so, and the step after it checks it. Commands
marked _(check `--help` first)_ were not in that check: run `<command> --help` once and adjust
the flags before relying on them.

How architecture, limits and data handling work: [hosted.md](hosted.md).

## 1. Stop everything, and what it can cost

Read this first. Fly has no spend limit and, per its cost docs, no billing alerts.

### Stop everything

In this order, so the API cannot start new machines while you clear them. **Needs Edward's OK.**

```powershell
# 1. Stop the API: no new scans, no new machines.
fly scale count 0 -a widedoor
# 2. List the scan machines, then destroy each one.
fly machine list -a widedoor-scan
fly machine destroy <machine-id> --force -a widedoor-scan
# 3. Check that both lists are empty.
fly machine list -a widedoor
fly machine list -a widedoor-scan
```

If anything is still running or billing after that, destroy both apps (this deletes them and
their secrets; the deploy starts over from section 3):

```powershell
fly apps destroy widedoor widedoor-scan -y
```

A leaked or misused deploy token can create machines in `widedoor-scan` outside every cap
below. If you suspect that (a `fly_sweep foreign=` above 0 is the sign), also revoke the token
(section 7) and destroy the scan machines.

### Spend check

- Billing, current month to date: <https://fly.io/dashboard/personal/billing> (pick the org if it
  is not `personal`). Check it daily for the first week, then weekly.
- Billing questions or a mistaken resource: `billing@fly.io`.

### Worst case

Fly prices from its pricing page (iad, 30 days of running):

| Item                               | Price                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| Scan machine, `shared-cpu-2x` 2 GB | $13.39 a month always on, billed per second while started (about $0.0186 an hour)                   |
| API machine, `shared-cpu-1x` 2 GB  | about $12.70 a month (derived: the 1 GB row, $6.70, plus 1 GB at $6.00; Fly does not list this row) |
| Outbound data                      | $0.02 per GB (North America and Europe)                                                             |

What the code allows (`jobs.ts`, `limits.ts`):

| Case                                                                                                                                    | Machine hours a day | About per 30 days |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------- |
| 300 open-tier scans a day, each to the 10 minute cap                                                                                    | 50                  | $27.90            |
| 200 open-tier scans at 10 minutes plus 100 verify jobs at 2 minutes (verify jobs count toward the 300)                                  | 36.7                | $20.50            |
| Ceiling: 3 machines busy all day (verified-tier scans run to 45 minutes, so 300 a day cannot all finish; the 3-machine cap binds first) | 72                  | $40.20            |
| The API, always on                                                                                                                      |                     | $12.70            |

So the ceiling is about **$53 per 30 days** plus outbound data, as long as only the API creates
machines. Scan machines are destroyed when their job ends, so stopped machines cost nothing.

## 2. Before the first deploy

All of these must be true. None needs Fly but the last two.

1. **The pre-deploy gate passed** on the commit being deployed (the controller runs it):
   `npm run lint`, `typecheck`, `test`, `build`, `format:check`, `test:ssrf`, `test:browser`,
   `test:docker`, `test:image`, `corpus:verify`, gitleaks, `npm audit`, and trivy on the scan
   image. `npm run test:ssrf` is the hosted tier's deploy gate: never deploy while it fails.
2. **Edward accepts the trivy result** (plan ruling 10). The scan image has 3 CRITICAL findings,
   all Debian 12 packages with no fix: CVE-2026-58016 (`libglib2.0-0`), CVE-2025-7458
   (`libsqlite3-0`) and CVE-2023-45853 (`zlib1g`). Chromium bundles its own zlib and sqlite. If
   a newer trivy run differs, it needs a new decision.
3. **Contact URL (decided 2026-10-28).** `WIDEDOOR_CONTACT_URL` is required and is set in
   `fly.toml` to `https://github.com/edwardjgriggs/widedoor/issues` (the repository is
   public). Before deploy, confirm on GitHub that the repository is public, that Issues are
   enabled, and that private vulnerability reporting is turned on (Settings, Security); a
   private repository gives site owners a 404, and `/about-scanner` sends security problems and
   anything private to `https://github.com/edwardjgriggs/widedoor/security/policy`, which needs
   that reporting turned on. The API does not start without it (`api_config_error name=WIDEDOOR_CONTACT_URL`). It is the one
   source: `/about-scanner` links to it, and the API passes it to every scan machine for the
   user agent site owners see. It must be an https URL with no user name or password. A
   `mailto:` address is not https, so publish an https page that shows a contact address (for
   example the repository's issues page once it is public, or a page on a site you own). The
   API also refuses `https://widedoor.fly.dev/about-scanner`, which would link to itself.
   Uncomment the line in `fly.toml` and set the URL.
4. **App names.** `widedoor` and `widedoor-scan` must be free on Fly. If `widedoor` is taken,
   change `app` and `WIDEDOOR_PUBLIC_ORIGIN` in `fly.toml`, and the names in this runbook. If
   `widedoor-scan` is taken, change `app` in `fly.scan.toml` and `WIDEDOOR_SCAN_APP` in
   `fly.toml`.
5. **The token's expiry.** Pick one; 90 days (`2160h`) is the recommendation. Put the rotation
   date in your calendar a week before it.
6. **Logs are shipped** somewhere that can alert, before the URL is announced (section 6).
7. **flyctl is logged in** to the right account (`fly auth whoami` _(check `--help` first)_).
8. **Both configs validate.** `fly config validate -c fly.toml` and
   `fly config validate -c fly.scan.toml` _(check `--help` first)_. The
   `[http_service.concurrency]` keys in `fly.toml` are not in the Fly facts this was checked
   against: if the validator rejects them, remove the block and note it.

## 3. Create the network, the apps, the token and the secrets

**Needs Edward's OK** for every step.

1. Create both apps on one new private network. The network is made by the first command and
   joined by the second. It can only be set when an app is created. Add `--org <org>` if you
   have more than one organization _(check `--help` first)_.

   ```powershell
   fly apps create widedoor --network widedoor-net
   fly apps create widedoor-scan --network widedoor-net
   ```

   Success: both commands name the new app. If either was created without the network flag,
   destroy it and create it again: the scan machines could not reach the API.

2. Create the deploy token for `widedoor-scan` and store it as a secret on `widedoor`, without
   it ever appearing on screen, in a file or in shell history. The whole line Fly prints,
   `FlyV1 fm2_...` with the prefix, is the value.

   Run this in **Git Bash**, not PowerShell. PowerShell's module logging, script block logging
   and transcription (`Start-Transcript`, or a policy that turns them on) can write a value built
   into a string, such as `"FLY_API_TOKEN=$token"`, to a log file. In Git Bash the token goes
   from one program to the next through a pipe and is never held in a variable; the history
   keeps only the command.

   ```bash
   fly tokens create deploy -a widedoor-scan -n widedoor-api -x 2160h \
     | grep -m1 '^FlyV1 ' | sed 's/^/FLY_API_TOKEN=/' | fly secrets import -a widedoor
   ```

   `grep -m1 '^FlyV1 '` passes on the token line only, so any other line flyctl prints stays
   out of the secret. Not confirmed by Fly's docs: what else `fly tokens create deploy` prints,
   and how `fly secrets import` reads a value with a space in it. The API checks the value at
   boot: if anything else got in, or nothing did, it logs `api_config_error name=FLY_API_TOKEN`
   and does not start (section 5, check 1). Never paste the token into chat, a file in the repo,
   or a command line. If you must use a file instead of the pipe, write it outside the repo,
   import it with `fly secrets import -a widedoor < <file>`, and delete it at once.

   **If the import fails** after `fly tokens create` succeeded (an error from
   `fly secrets import`, or `FLY_API_TOKEN` missing in step 3), a live token exists that no
   secret holds. Revoke it before you try again: list the tokens of `widedoor-scan` with
   `fly tokens list -a widedoor-scan`, find the one named `widedoor-api` (or the name you
   gave), and revoke it with `fly tokens revoke <token-id>` (both _(check `--help` first)_).
   Then run the step again. **Needs Edward's OK.**

3. List the secrets (names only) to check:

   ```powershell
   fly secrets list -a widedoor
   ```

   Success: `FLY_API_TOKEN` is listed.

4. Section 4 sets `WIDEDOOR_SCAN_IMAGE`; the API will not start without it.

`widedoor-scan` needs no secrets: the API passes each scan machine everything it needs (the
control URL, the job id and token, and the contact URL) in the machine's config.

## 4. Build the scan image, then deploy the API

**Needs Edward's OK** for every step.

1. Build the scan image on Fly's builder and push it to `widedoor-scan`'s own registry, with the
   scan app's own config (`fly.scan.toml`: app `widedoor-scan`, target `scan`, no service).
   Pick a label you will recognize later, such as the date and commit (`2026-10-28-<commit>`).

   ```powershell
   fly deploy --config fly.scan.toml --build-only --push --image-label <label>
   ```

   Success: flyctl ends with `image: registry.fly.io/widedoor-scan:<label>`. `--push` is
   needed: a build-only image without it could not be found later (a Fly community report, not
   the docs). An image of the wrong target fails at the first scan: the machine has no
   `/app/docker/scan-entry.sh`.

2. Read the image's digest. The API takes the scan image only pinned by digest, in the scan
   app's registry: `registry.fly.io/widedoor-scan@sha256:<64 hex>`. A label can be moved to
   another image; a digest cannot. Look for `digest: sha256:...` in the push output of step 1.
   To read it again (or if the output has none), log Docker in to Fly's registry and inspect the
   label; both commands _(check `--help` first)_:

   ```powershell
   fly auth docker
   docker buildx imagetools inspect registry.fly.io/widedoor-scan:<label>
   ```

   The `Digest:` line is the value. Write the label and the digest down; a rollback needs them.

3. Tell the API which image to start. It is not a secret, but as a staged secret it survives
   every later deploy, and a rollback is one command:

   ```powershell
   fly secrets set --stage WIDEDOOR_SCAN_IMAGE=registry.fly.io/widedoor-scan@sha256:<digest> -a widedoor
   ```

   Anything but that exact form (a label, another app's registry, upper-case hex) stops the API
   with `api_config_error name=WIDEDOOR_SCAN_IMAGE`.

4. Deploy the API, one machine only (`--ha=false`: by default flyctl adds a second machine,
   which would split the jobs between two memories):

   ```powershell
   fly deploy --ha=false -a widedoor
   fly machine list -a widedoor
   ```

   Success: the deploy finishes with the health check passing, and the list shows exactly one
   machine, started. If it shows two, destroy the newer one.

## 5. Smoke checks

Each check is a deploy blocker until it passes. If one fails: stop everything (section 1),
then fix and redeploy. Read the logs with `fly logs -a widedoor` and `fly logs -a
widedoor-scan` _(check `--help` first)_. Every log line is `widedoor event=<name>` and fields.

### 1. The API boots and the token works

In `fly logs -a widedoor`, right after the deploy:

- `widedoor event=api_ready`: the API started.
- `widedoor event=fly_sweep destroyed=0 failed=0 foreign=0 first=1`: the first sweep listed
  `widedoor-scan`'s machines with the token, so Fly accepted `Authorization: Bearer FlyV1 ...`
  for that app. The first sweep after a start destroys every scan machine left from an earlier
  run, of any age (a fresh API holds no jobs), so `destroyed=` above 0 here is normal after a
  restart. `foreign=` counts machines in `widedoor-scan` that the API did not create; it must
  be 0 (the debug machine of check 6 counts while it exists).

Failures:

- `api_config_error name=<NAME>`: that setting is missing or invalid (`FLY_API_TOKEN`,
  `WIDEDOOR_SCAN_IMAGE`, `WIDEDOOR_PUBLIC_ORIGIN`, `WIDEDOOR_CONTACT_URL`, `FLY_REGION`,
  `FLY_PRIVATE_IP`, `WIDEDOOR_SCAN_APP`, or `ui_build` for a missing hosted page). The log never
  holds the value.
- `api_start_failed code=<E...>`: a listener could not start.
- `fly_auth_failed status=401` or `403`, then `fly_sweep status=<n> reason=list_failed`: Fly
  refused the token. Check it was made for `widedoor-scan`, not `widedoor`.
- The health check fails while `api_ready` was logged: Fly's check may reach the machine over
  IPv6, and the public listener binds IPv4 (`0.0.0.0`) only. Fly's docs did not say which; this
  needs a code change to bind `::` if so.

### 2. Self-scan refusal, then a real scan

On <https://widedoor.fly.dev/>:

1. Scan `https://widedoor.fly.dev/about-scanner`. Success: the page says "Widedoor does not scan
   itself." and the log has `refused reason=self status=400 host=widedoor.fly.dev ip=<prefix>`.
   No machine starts.
2. Scan a small public page you choose, ideally one whose server log you can read. Success,
   in this order in `fly logs -a widedoor`:
   `scan_queued job=<id> tier=open host=<host> ip=<prefix>`, `scan_started`,
   `fly_create job=<id> machine=<machine-id> ms=<n>`, `scan_done`,
   `fly_destroy job=<id> machine=<machine-id> status=200` (or `status=404` when the machine had
   already removed itself); and the page shows the report. In `fly logs -a widedoor-scan`, the
   scan ends with `egress_summary job=<id> refused=<n> ...`. In your site's access log, the
   user agent is `Mozilla/5.0 (compatible; Widedoor/<version>; +<contact URL>)` with the contact
   URL from `fly.toml`.

This also proves two things Fly's docs do not: a machine create in `widedoor-scan` with an
image pinned by digest (`registry.fly.io/widedoor-scan@sha256:<digest>`) works, and the machine
starts in the API's region (the API passes its `FLY_REGION`; `fly machine list -a
widedoor-scan` shows the region while the scan runs). `fly_create job=<id> status=<n>` with no
machine means the create failed: 401 or 403 is the token, 404 or 422 most likely the image ref.

### 3. A metadata address is refused

Scan `http://169.254.169.254/`. Success: 400, the page says "Widedoor will not scan
169.254.169.254: address is metadata.", the log has
`refused reason=metadata status=400 host=169.254.169.254 ip=<prefix>`, and no machine starts.

### 4. Fly-Client-IP cannot be forged

Fly's docs do not say that its proxy replaces a `Fly-Client-IP` header the client sent. Send
one and read what the API used:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -H "Fly-Client-IP: 1.2.3.4" https://widedoor.fly.dev/api/scans/0
```

Success: `404`, and the log line `refused reason=not_found path_class=api ip=<prefix>` shows
your own network (your IPv4 address with the last part `0`, or the first three groups of your
IPv6 address), not `1.2.3.0`. If it shows `1.2.3.0`, anyone can dodge the rate limits: stop
everything.

### 5. Firefox

Run check 2's real scan once in Firefox. The page sends `Referrer-Policy: no-referrer`, and the
API refuses a POST whose `Origin` is not `https://widedoor.fly.dev`. Success: the scan reaches
done. Failure: "Forbidden: the request did not come from the Widedoor site." and
`refused reason=origin status=403` in the log. That blocks every Firefox user and needs a code
change.

### 6. The scan machine on Fly's kernel

The Docker tests prove the lockdown on Docker's kernel, over IPv4 only. These checks prove it on
Fly.

First, the scan app has no public address (`fly.scan.toml` has no service). _(Check
`--help` first.)_

```powershell
fly ips list -a widedoor-scan
```

Success: an empty list. If it lists any address, release it _(`fly ips release`, check
`--help` first)_.

From check 2's scan, in `fly logs -a widedoor-scan`:

- **The nftables ruleset loads.** The entry stops with `entry_failed step=firewall_rules` if the
  rules cannot be built, `step=nftables` if `nft -f` cannot load them, and
  `step=nftables_verify` if `nft list table inet widedoor` fails or does not show `policy drop`
  on the input, forward and output chains. A scan that reached done got past them. The rules
  are native nftables (`meta skuid`, `ct original`) because Fly's kernel (`6.12.114-fly`) has no
  xt owner match: on 2026-10-29 every iptables `-m owner` rule failed to load
  (`Extension owner revision 0 not supported`) and the entry stopped at `step=iptables`,
  before any scan ran.
- **The `/.fly/api` lock holds.** If the socket exists and cannot be locked to root (socket
  0600, folder 0700), the entry stops with `entry_failed step=fly_api`.
- **IPv6 over the 6PN works under the firewall.** The agent reached the API's control listener,
  an `fdaa:` address, or the job could not have finished. The proxy's DNS worked too.
- **No scan-user process survived.** The agent logs `agent_reaped found=no passes=1` (nothing
  was left) or `found=yes passes=<n>` (it killed what was left). `agent_reap_failed` or
  `agent_reap_incomplete` is a failure.

The rest needs a one-off debug machine in `widedoor-scan` that does not run the entry at boot,
so you can look before and after it runs. **Needs Edward's OK.**

```powershell
# A scan-image machine that only sleeps, with the scan machines' size.
fly machine run registry.fly.io/widedoor-scan@sha256:<digest> -a widedoor-scan --entrypoint "sleep 1800" --vm-size shared-cpu-2x --vm-memory 2048
fly ssh console -a widedoor-scan --machine <debug-machine-id>
```

Both commands _(check `--help` first)_. While it exists, the API's sweeps log `foreign=1` (it
carries no `widedoor_role`); that is expected here and nowhere else. In the console (root),
before the entry:

```sh
cat /etc/resolv.conf                       # the resolver; Fly's is fdaa::3
cat /proc/net/if_inet6                     # eth0's fdaa: address; flags 80 = permanent (static)
cat /proc/sys/net/ipv6/conf/all/accept_ra /proc/sys/net/ipv6/conf/eth0/accept_ra
ls -la /.fly                               # whether the machine API socket exists
```

Then run the entry against the real API with a job id that does not exist. The API machine's
id is in `fly machine list -a widedoor`; any 32 hex characters work as the job id.

```sh
WIDEDOOR_CONTROL_URL=http://<api-machine-id>.vm.widedoor.internal:8081 \
WIDEDOOR_JOB_ID=0123456789abcdef0123456789abcdef WIDEDOOR_JOB_TOKEN=x \
/app/docker/scan-entry.sh; echo "exit $?"
```

The console stays connected: the firewall lets established connections through. Read:

- `widedoor event=agent_input_unavailable job=... status=404` then `exit 1`: the firewall
  loaded, and root reached the control listener over IPv6 (the API answers 404 for an unknown
  job, and logs `control_refused route=input reason=unauthorized`).
  `agent_input_unavailable` with no status means it could not reach it: a failure.
- `nft list ruleset`: `table inet widedoor` is loaded, with `policy drop` on its input, forward
  and output chains (the scan image has no iptables).
- `stat -c '%U %a' /.fly /.fly/api`: `root 700` and `root 600`, if they exist.
- `awk '$8 ~ /^@/' /proc/net/unix`: abstract sockets. Any listed is reachable by uid 10001, since
  abstract sockets have no file permissions and the firewall does not cover them. None is a
  pass; any listed needs a look at what owns it before going live.
- `ps -u 10001`: no process is a pass.
- **Router advertisements.** If eth0's `fdaa:` address is permanent (flags `80`) and `accept_ra`
  is 0 or the default route did not come from an advertisement, Fly configures IPv6 statically.
  Then a follow-up narrows the firewall's neighbor discovery rule (R33) to types 135 and 136
  and sets `accept_ra` to 0. Either way, note what you saw.

Then destroy the debug machine. The API's sweep never destroys a machine without
`widedoor_role` (it only counts it), so it bills until you do. **Needs Edward's OK.**

```powershell
fly machine destroy <debug-machine-id> --force -a widedoor-scan
```

If any of these fails: stop everything (section 1). Nothing goes live with a scan machine that
is not locked down.

### 7. The verify path (optional, recommended)

On a host you control, start a verification on the hosted page, publish the token as
`https://<host>/.well-known/widedoor.txt`, and check it. Success in `fly logs -a widedoor`:
`verify_created host=<host> ip=<prefix> vref=<vref>`, `verify_checked method=dns_txt ok=false`,
`verify_job_queued`, `fly_create`,
`verify_checked method=well_known ok=true host=<host> vref=<vref>`, and the page says verified.
Then scan a page on that host: `scan_queued ... tier=verified vref=<vref>`.

### 8. The proxy's concurrency limit

`fly config show -a widedoor` _(check `--help` first)_ shows the deployed config. Success: its
`http_service` has `concurrency` with `type` `requests`, `soft_limit` 150 and `hard_limit` 200.
If the block is missing, Fly ignored the keys: fix `fly.toml` and redeploy.

### 9. The API machine's real memory

The sizing (section 7, machine size) assumes 2048 MiB and was measured on Windows, where peak
memory is the working set, not Linux RSS. Read the real numbers on the API machine once it has
booted. **Needs Edward's OK.**

```powershell
fly ssh console -a widedoor
```

_(check `--help` first)_. In the console:

```sh
grep MemTotal /proc/meminfo               # the machine's memory, in kB
grep VmRSS /proc/$(pidof node)/status     # the API's resident memory after boot, in kB
```

The hosted image has no `ps`; `pidof` and `/proc` are enough. Rule: if MemTotal (in MiB,
kB / 1024) minus the sizing sum (1826.1 MiB, section 7) leaves less than about
100 MiB, lower the heap to 768: `--max-old-space-size` in `fly.toml`, `API_HEAP_MB` in
`packages/server/src/hosted/limits.ts` and the pinned test that checks them, then redeploy.
Note the API's RSS after boot in the deploy notes; a much higher number than expected also
needs a look before the URL is announced.

## 6. Logs and alerts

### Ship logs before announcing the URL

`fly logs` shows only what arrives while it runs. Before the URL is public, ship both apps'
logs to a store that keeps them and can alert. Fly documents a log shipper app for this (see
"exporting logs" in Fly's docs; it is not part of the Fly facts this runbook was checked
against, so read Fly's page before setting it up). The store needs the same access rule as
below.

### Who reads the logs

Only Edward. Give no one else access to the Fly org or the log store.

- A job id is a capability: for an hour it downloads that scan's reports, and it cancels a
  running scan. Never paste log lines with job ids into an issue or a chat.
- A `vref` is a correlation key, not a verification id: it ties a verification's lines together
  and grants nothing.
- The log holds the hosts people scanned and their networks (IPv4 /24 or IPv6 /48). Treat it as
  personal data.

### What to watch

Fly's docs list no log alerting; the log store does it. The conditions, by log line. The API's
lines come from `widedoor`, the scan machines' (`egress_*`, `entry_*`, `agent_*`) from
`widedoor-scan`; a scan machine's lines carry `job=<id>`, which joins them to the API's
`scan_queued job=<id> ... ip=<prefix>` line and so to a client network.

| Condition                                                                                                                     | Meaning                                                                                                                         | Action                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Any `fly_auth_failed`                                                                                                         | The token is expired, revoked or for the wrong app. No scan can start                                                           | Page. Rotate the token (section 7)                                       |
| Any `fly_sweep foreign=<n>` with n above 0 (outside smoke check 6)                                                            | Machines in `widedoor-scan` the API did not create: the token may be in other hands                                             | Page. Stop everything (section 1), revoke the token                      |
| `fly_sweep destroyed=<n>` with n above 0, not on a `first=1` line                                                             | A scan machine outlived its cap (a destroy that failed)                                                                         | Check the scan machines; look for `fly_destroy` failures                 |
| `fly_sweep timed_out=1`, `reason=list_failed` or `reason=foreign_list_failed`                                                 | The sweep could not run                                                                                                         | Check Fly's status and the token                                         |
| No `fly_sweep` line at all for 30 minutes (the heartbeat: a sweep logs one every 10 minutes)                                  | The API is down or its sweep loop is dead, so no machine past its cap is being destroyed                                        | Page. Check `fly machine list` of both apps; restart the API             |
| Any `entry_failed`                                                                                                            | A scan machine could not lock itself down; its scan did not run                                                                 | Page. Read the `step=`; stop everything if it repeats                    |
| Any `agent_reap_incomplete` or `agent_reap_failed`                                                                            | A scan-user process may have outlived its scan                                                                                  | Page. Look at the job; the machine is destroyed anyway                   |
| Any `egress_refused ... reason=metadata` (scan app), joined by `job=` to its `scan_queued` network                            | A scanned page tried the cloud metadata address                                                                                 | Watch that network; consider blocking it                                 |
| `egress_summary` with `metadata=`, `private=`, `link_local=` or `loopback=` above 0                                           | The same, counted even past the 200-line cap per event                                                                          | Join by `job=` to the network; watch it                                  |
| Any `egress_lines_dropped` or `agent_child_stderr_dropped`                                                                    | A scan wrote more, or other, log lines than it may: a hostile page or a broken child                                            | Look at the job and its network                                          |
| `refused reason=metadata`, `private`, `link-local` or `loopback` from one `ip=` 3 or more times in 10 minutes                 | Someone probing for internal addresses through the API                                                                          | Watch that network; consider blocking it                                 |
| `refused reason=rate`, `reason=busy` or `reason=busy_network` from one `ip=` more than 10 times an hour                       | A client hammering the limits, or trying to run many scans at once                                                              | Watch it                                                                 |
| `scan_queued` plus `verify_job_queued` above 50 in an hour                                                                    | The 300-a-day cap goes in under 6 hours                                                                                         | Check whether it is one network; check the bill                          |
| `verify_created` for 10 or more distinct hosts from one `ip=` in an hour                                                      | Someone collecting verifications                                                                                                | Watch it                                                                 |
| `report_download` of 20 or more distinct jobs from one `ip=` in an hour                                                       | Report harvesting: job ids leaked somewhere                                                                                     | Check where job ids could have leaked                                    |
| One `vref` from 3 or more distinct `ip=` networks                                                                             | A verification id shared or leaked                                                                                              | It expires in 24 hours; watch its scans                                  |
| `control_refused` with `reason=unauthorized` or `no_route` more than a few times an hour, or any `control_refused_suppressed` | Something on the private network is guessing job ids or tokens (`reason=ended` after a cap, or `delivering`, is a slow machine) | Page. Check `fly machine list` of both apps for machines you do not know |
| Any `refused reason=not_found_suppressed`                                                                                     | One network passed 20 not-found requests in a minute (a scanner or a broken client)                                             | Watch it                                                                 |
| `not_found` from one `ip=` steady all day                                                                                     | Often a tab left open polling a forgotten scan: polls of a scan forgotten after 24 hours log `path_class=api` too               | Usually nothing                                                          |
| `refused reason=busy_download` from many `ip=` networks in a few minutes                                                      | All 64 download places are taken: someone may be holding them open, so everyone's results stall                                 | Look for one network's `download_ended reason=deadline` lines            |
| `download_ended reason=deadline` from one `ip=` more than a few times an hour, or any `download_ended_suppressed`             | A client opening report downloads and not reading them (holding places until the deadline)                                      | Watch that network; consider blocking it                                 |

`not_found` lines are capped at 20 a minute per network; past that, one
`refused reason=not_found_suppressed count=<n> ip=<prefix>` line gives the count after the
minute. `control_refused` lines are capped the same way per route, with one
`control_refused_suppressed route=<route> count=<n>` line, and `download_ended` lines
(`reason=deadline`, `cancelled` or `dropped`) per network, with one
`download_ended_suppressed count=<n> ip=<prefix>` line. A scan machine's `egress_*` lines
are capped at 200 per event name per scan; `egress_lines_dropped` counts the rest, and
`egress_summary` counts every refusal by reason.

## 7. Rotate, redeploy, roll back

Any restart of the API forgets every job, report and verification, and its first sweep then
destroys every scan machine left running. Do these when no scan is running (a `scan_started`
or `verify_job_started` with no end since).

### Rotate the token

Before it expires. **Needs Edward's OK.** In Git Bash, as in section 3:

```bash
fly tokens create deploy -a widedoor-scan -n widedoor-api-<date> -x 2160h \
  | grep -m1 '^FlyV1 ' | sed 's/^/FLY_API_TOKEN=/' | fly secrets import -a widedoor
```

The API restarts with the new token. Check section 5, check 1 (`fly_sweep ... first=1`, no
`fly_auth_failed`). Then revoke the old token: find it by name with `fly tokens list -a
widedoor-scan` and revoke it with `fly tokens revoke <token-id>` (both _(check `--help`
first)_). If the import failed, revoke the new token instead, as section 3, step 2 says, and
try again.

### Redeploy

**Needs Edward's OK.** The scan image first, so the API never names an image that does not
exist:

```powershell
fly deploy --config fly.scan.toml --build-only --push --image-label <new-label>
# Read the new digest as in section 4, step 2.
fly secrets set --stage WIDEDOOR_SCAN_IMAGE=registry.fly.io/widedoor-scan@sha256:<new-digest> -a widedoor
fly deploy --ha=false -a widedoor
```

Then smoke checks 1 and 2. When the scan image changed, check 6 too (the log part).

### Roll back

**Needs Edward's OK.**

- **The scan image:** point the API at the previous digest. This restarts the API.

  ```powershell
  fly secrets set WIDEDOOR_SCAN_IMAGE=registry.fly.io/widedoor-scan@sha256:<previous-digest> -a widedoor
  ```

- **The API:** find the previous release's image with `fly releases -a widedoor --image` _(check
  `--help` first)_, then deploy it:

  ```powershell
  fly deploy --ha=false --image <previous-api-image-ref> -a widedoor
  ```

Then smoke checks 1 and 2.

### Changing the API's machine size

`fly.toml` gives the API `shared-cpu-1x` with 2048 MiB and `--max-old-space-size=896` (ruling
R50; `API_MEMORY_MB` and `API_HEAP_MB` in `packages/server/src/hosted/limits.ts`). Kept reports,
queued PDFs, uploads being read and the raw result body are Buffers outside the V8 heap; the
budget for kept reports and queued PDFs is 512 MiB (`MAX_RETAINED_BYTES` in `jobs.ts`, counted
exactly). The text decoded from a result, the parsed report and its renderings are in the heap.
The worst case is the sum, and it must fit:

| Part                                                                   | MiB    |
| ---------------------------------------------------------------------- | ------ |
| V8 heap (`--max-old-space-size`)                                       | 896    |
| Retained budget (kept reports and queued PDFs)                         | 512    |
| 4 uploads of 25 MiB being read, about 2 copies each                    | 200    |
| One raw verified result body (`resultBodyMax('verified')`, 32 MiB cap) | 64     |
| Downloads in flight (64 x 64 KiB views, no copies)                     | 4      |
| Node and the OS                                                        | 150    |
| Total, against 2048                                                    | 1826.1 |

The heap must also be at least 512 and at least 1.5 times `MEASURED_PEAK_HEAP_MB` (422 MiB in
`limits.ts`): the peak heap of one near-cap verified result in its worst shape, where one
character above U+00FF makes every string V8 builds two-byte. Measure with
`npx tsx packages/server/test/hosted-memory.measure.ts --at=<heap>` (on Node 24.19.0 at the
32 MiB cap: the two-byte shape completes from a 366 MB heap, and samples 422 MiB at a 768 heap).
The numbers were measured on Windows, where peak memory is the working set, not Linux RSS;
smoke check 9 reads the real ones on the API machine. A unit test reads `fly.toml` and checks
both rules.

To shrink the machine, apply the same two rules to the new `memory`: lower the heap, then
`MAX_RETAINED_BYTES`, then the verified `reportMaxBytes` (which halves the result body), until
the sum fits; measure again after each change to a report cap. 1024 MiB does not fit at
today's caps: even a 512 heap with the 200 for uploads and the 150 overhead leaves 162 for the
budget and the result body together, so it would also need fewer uploads at once. Each of these
is a code change, so it goes through the gate. Then redeploy. A `[[vm]]` section means `fly deploy`
resets any size set with `fly scale vm`.
