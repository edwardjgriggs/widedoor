import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISOLATED_HOST_ENV, VERAPDF_IMAGE_REF } from '@widedoor/pdf';
import { ROOT } from './helpers.ts';

/*
 * Offline checks of the Dockerfile and the Chromium seccomp profile, so a
 * base image bump or an edit cannot quietly unpin an image, desync veraPDF
 * from the Docker runner or turn the browser sandbox off. The image itself
 * is tested by npm run test:image.
 */

const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/gm)].map((m) => ({
  from: m[1] as string,
  name: m[2],
}));
const stageNames = new Set(stages.map((s) => s.name));
/** Base images: every FROM that does not build on an earlier stage. */
const froms = stages.map((s) => s.from).filter((from) => !stageNames.has(from));
/** The text of one stage, from its FROM line to the next. */
const stage = (name: string): string => {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, 'm'));
  const next = dockerfile.slice(start + 1).search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
};

describe('Dockerfile', () => {
  it('pins every base image by tag and digest', () => {
    expect(froms.length).toBeGreaterThan(0);
    for (const ref of froms) expect(ref).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('takes veraPDF from the image the Docker runner pins', () => {
    expect(froms).toContain(VERAPDF_IMAGE_REF);
  });

  it('marks the image as the isolation boundary and runs as a fixed non-root user', () => {
    expect(dockerfile).toMatch(new RegExp(`^\\s+${ISOLATED_HOST_ENV}=1$`, 'm'));
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    // The hosted API and the CLI; the scan target's entry runs as root and drops itself.
    expect(users).toEqual(['10001:10001', '10001:10001']);
    expect(stage('cli')).toMatch(/^USER 10001:10001$/m);
    expect(stage('hosted')).toMatch(/^USER 10001:10001$/m);
    expect(stage('scan')).not.toMatch(/^USER /m);
  });

  it('builds the CLI by default, and the scan and hosted targets on the shared base', () => {
    expect(stages.at(-1)).toEqual({ from: 'base', name: 'cli' });
    expect(stages.filter((s) => s.from === 'base').map((s) => s.name)).toEqual([
      'scan',
      'hosted',
      'cli',
    ]);
    // Only the scan target gets the firewall tools and the reaper's pkill.
    expect(stage('base')).not.toMatch(/apt-get install.*(nftables|iptables|procps)/);
    expect(stage('scan')).toMatch(/apt-get install -y --no-install-recommends nftables procps/);
    expect(stage('scan')).toContain('test -x /usr/sbin/nft');
    // Only root (the entry) may run nft.
    expect(stage('scan')).toMatch(/^\s+&& chmod 0700 \/usr\/sbin\/nft \\$/m);
    // The firewall is native nftables: Fly's kernel has no xt owner match for iptables.
    expect(dockerfile).not.toMatch(/apt-get install.*iptables/);
    expect(stage('scan')).toContain('ENTRYPOINT ["/app/docker/scan-entry.sh"]');
    // The test switches never reach an image.
    expect(dockerfile).not.toMatch(/WIDEDOOR_(AGENT|EGRESS)_SAME_USER/);
  });

  it('never turns the Chromium sandbox off', () => {
    expect(dockerfile).not.toMatch(/no-sandbox|unsafeNoSandbox|SYS_ADMIN|unconfined/i);
  });

  it('carries no base image labels a Dependabot bump could leave stale', () => {
    expect(dockerfile).not.toContain('org.opencontainers.image.base.');
  });

  it('labels the bundled licenses and points to the notices file it copies in', () => {
    expect(dockerfile).toContain('org.opencontainers.image.licenses="Apache-2.0 AND ');
    expect(dockerfile).toContain('io.widedoor.third-party-notices="/app/THIRD-PARTY-NOTICES.txt"');
    expect(dockerfile).toMatch(/^COPY .*docker\/THIRD-PARTY-NOTICES\.txt \.\/$/m);
  });

  it('copies every workspace package.json into both npm ci stages', () => {
    const packages = readdirSync(join(ROOT, 'packages')).filter((p) =>
      existsSync(join(ROOT, 'packages', p, 'package.json')),
    );
    expect(packages).toContain('server');
    for (const stage of [' AS build\n', ' AS deps\n', ' AS deps-cli\n']) {
      const from = dockerfile.indexOf(stage);
      const ci = dockerfile.indexOf('RUN npm ci', from);
      const copies = dockerfile.slice(from, ci);
      for (const p of packages)
        expect(copies, `${p} in${stage}`).toContain(
          `COPY packages/${p}/package.json packages/${p}/\n`,
        );
    }
  });

  it('keeps @widedoor/ai and the provider SDKs out of the scan and hosted images (D16)', () => {
    // The shared base installs only the server workspace and drops the ai package.json again.
    const deps = stage('deps');
    expect(deps).toMatch(
      /RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @widedoor\/server \\\n/,
    );
    expect(deps).not.toMatch(/--workspace @widedoor\/(cli|ai)\b/);
    expect(deps).toContain('rm -rf .npmrc packages/ai');
    for (const gone of [
      'node_modules/@widedoor/ai',
      'node_modules/@anthropic-ai',
      'node_modules/openai',
    ])
      expect(deps).toContain(`test ! -e ${gone}`);
    expect(stage('base')).toMatch(/^COPY --from=deps \/app \.\/$/m);
    // Nothing the scan and hosted images build on, nor they themselves, reaches the CLI's
    // dependencies or the ai package.
    for (const name of ['base', 'scan', 'hosted']) {
      expect(stage(name), name).not.toContain('deps-cli');
      expect(stage(name), name).not.toContain('packages/ai');
    }
    // Only the CLI target adds them.
    expect(stage('deps-cli')).toContain('--workspace @widedoor/cli');
    const cli = stage('cli');
    expect(cli).toContain('COPY --from=deps-cli /app/node_modules node_modules');
    expect(cli).toContain('COPY --from=build /src/packages/ai/dist packages/ai/dist');
  });

  it('copies the build output of the CLI and every Widedoor package it depends on', () => {
    const deps = (name: string): string[] => {
      const json = JSON.parse(
        readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      return Object.keys(json.dependencies ?? {})
        .filter((d) => d.startsWith('@widedoor/'))
        .map((d) => d.slice('@widedoor/'.length));
    };
    const needed = new Set<string>();
    const visit = (name: string) => {
      if (needed.has(name)) return;
      needed.add(name);
      deps(name).forEach(visit);
    };
    visit('cli');
    expect([...needed]).toContain('server');
    for (const p of needed)
      expect(dockerfile).toContain(
        `COPY --from=build /src/packages/${p}/dist packages/${p}/dist\n`,
      );
  });

  it('installs Chromium before any Widedoor build output, so a source edit reuses that layer', () => {
    const install = dockerfile.indexOf('playwright install');
    const runtime = dockerfile.indexOf(' AS base');
    const firstApp = dockerfile.indexOf('COPY --from=build', runtime);
    expect(install).toBeGreaterThan(runtime);
    expect(firstApp).toBeGreaterThan(install);
  });
});

describe('docker/chromium-seccomp.json', () => {
  const profile = JSON.parse(
    readFileSync(join(ROOT, 'docker', 'chromium-seccomp.json'), 'utf8'),
  ) as {
    defaultAction: string;
    syscalls: { names: string[]; action: string; includes?: unknown; excludes?: unknown }[];
  };

  it("is Docker's deny-by-default profile with one unconditional rule for the sandbox calls", () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    const added = profile.syscalls.at(-1);
    expect(added).toMatchObject({
      names: ['chroot', 'clone', 'unshare'],
      action: 'SCMP_ACT_ALLOW',
    });
    expect(added?.includes).toBeUndefined();
    expect(added?.excludes).toBeUndefined();
  });

  it("keeps every other rule exactly as Docker's default (moby/profiles seccomp v0.2.3)", () => {
    // SHA-256 of JSON.stringify of the parsed upstream default.json (raw file sha256
    // 536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74). See docker/README.md.
    const upstream = { ...profile, syscalls: profile.syscalls.slice(0, -1) };
    expect(createHash('sha256').update(JSON.stringify(upstream)).digest('hex')).toBe(
      'afb4934b023cfceaaec1a9d752ca3f801aaa96eb2e59abe6e7ea16976948e080',
    );
  });
});
