# Widedoor CLI image: Node 24, Playwright's Chromium (OS sandbox on) and
# veraPDF 1.30.3 on a jlinked Temurin 11 runtime. Every base image is pinned by
# tag and digest. Build: docker build -t widedoor:dev . (the CLI; the hosted scan
# machine and API are the targets scan and hosted, near the end).
# Run web and PDF scans separately, hardened as below (README, Docker section).
# WIDEDOOR is the path of the Widedoor clone that holds the seccomp profile.
# Web pages (the seccomp profile lets Chromium start its sandbox):
#   mkdir -p widedoor-report/web
#   docker run --rm --init --user "$(id -u):$(id -g)" --cap-drop ALL \
#     --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m \
#     --security-opt seccomp="$WIDEDOOR/docker/chromium-seccomp.json" \
#     -v "$PWD/widedoor-report/web:/work/out" widedoor:dev scan https://example.com/ --out out
# PDFs (no network, inputs read-only, Docker's default seccomp profile):
#   mkdir -p widedoor-report/pdf
#   docker run --rm --init --user "$(id -u):$(id -g)" --network none --cap-drop ALL \
#     --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=512m \
#     -v "$PWD/docs:/work/docs:ro" -v "$PWD/widedoor-report/pdf:/work/out" \
#     widedoor:dev scan docs/annual-report.pdf --out out

# Build stage: dev dependencies, TypeScript build and the viewer bundle.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/pdf/package.json packages/pdf/
COPY packages/report/package.json packages/report/
COPY packages/ai/package.json packages/ai/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/ui/package.json packages/ui/
COPY packages/action/package.json packages/action/
COPY packages/docs/package.json packages/docs/
RUN npm ci --ignore-scripts --include=dev --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
RUN npm run build

# Production dependencies only, from the same lockfile, for the shared base that the scan
# and hosted images use: only the server workspace and what it depends on, so neither
# image holds @widedoor/ai or a provider SDK (D16), nor the docs site. npm ci needs every
# workspace's package.json to check the lockfile; the ai and docs ones are removed again
# after the install.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/pdf/package.json packages/pdf/
COPY packages/report/package.json packages/report/
COPY packages/ai/package.json packages/ai/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/ui/package.json packages/ui/
COPY packages/action/package.json packages/action/
COPY packages/docs/package.json packages/docs/
# .npmrc only steers npm ci; it never reaches the runtime image.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @widedoor/server \
    && npm cache clean --force \
    && rm -rf .npmrc packages/ai packages/docs node_modules/@widedoor/docs \
    && test ! -e node_modules/@widedoor/ai \
    && test ! -e node_modules/@widedoor/docs \
    && test ! -e node_modules/@anthropic-ai \
    && test ! -e node_modules/openai

# The CLI image's production dependencies: the cli workspace, which adds @widedoor/ai and
# the provider SDKs (never the docs site). Only the cli target copies from here.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS deps-cli
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/pdf/package.json packages/pdf/
COPY packages/report/package.json packages/report/
COPY packages/ai/package.json packages/ai/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/ui/package.json packages/ui/
COPY packages/action/package.json packages/action/
COPY packages/docs/package.json packages/docs/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @widedoor/cli \
    && npm cache clean --force \
    && rm -rf .npmrc packages/docs node_modules/@widedoor/docs

# A Java runtime with the modules the upstream veraPDF image ships (its own
# runtime is built for musl and does not run on Debian).
FROM eclipse-temurin:11.0.32.1_1-jdk@sha256:74983af862a6656ceb6cbb1407391c15d6e79aa0c5bf65117e6ef534399b49ea AS jre
RUN jlink \
      --add-modules java.base,java.compiler,java.datatransfer,java.xml,java.prefs,java.desktop,java.logging,java.management,jdk.crypto.ec,jdk.management \
      --strip-debug --no-man-pages --no-header-files --compress=2 \
      --output /opt/jre

# veraPDF 1.30.3 itself, from the same pinned image the Docker runner uses (VERAPDF_IMAGE_REF).
FROM verapdf/cli:v1.30.3@sha256:d565095c67a083e693aebf7d1a15784007370571053fc1aa5b502665b9a78f9c AS verapdf

# Everything the CLI, scan and hosted images share. It sets no user or entry point: the
# targets below do, and the CLI target comes last so `docker build .` builds it.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
ARG WIDEDOOR_VERSION=0.1.0
# The licenses label covers what the image bundles; THIRD-PARTY-NOTICES.txt in
# the image says where each component's license and source are.
LABEL org.opencontainers.image.title="widedoor" \
      org.opencontainers.image.description="Accessibility checker for websites and PDFs against Section 508 and WCAG 2.1 AA" \
      org.opencontainers.image.licenses="Apache-2.0 AND (GPL-3.0-or-later OR MPL-2.0) AND GPL-2.0-only WITH Classpath-exception-2.0 AND LicenseRef-Widedoor-Bundled-Third-Party" \
      org.opencontainers.image.version="${WIDEDOOR_VERSION}" \
      io.widedoor.third-party-notices="/app/THIRD-PARTY-NOTICES.txt" \
      io.widedoor.verapdf.version="1.30.3"

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/java/openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    WIDEDOOR_ISOLATED_HOST=1

# Layers that change rarely come first, so a source edit reuses the Chromium
# and apt layer: the production node_modules depend only on the lockfile and
# the package.json files.
WORKDIR /app
COPY --from=deps /app ./

# Chromium (headless shell) from the Playwright version in the lockfile, with its
# system libraries. Then: Debian security updates; Xvfb and ffmpeg go (headless
# never uses them); npm, npx, corepack and yarn go (nothing runs them at run
# time, and npm's bundled modules carry most of the image's Node.js CVEs).
RUN export DEBIAN_FRONTEND=noninteractive \
    && npx --no-install playwright install --with-deps --only-shell chromium \
    && apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get purge -y xvfb xserver-common \
    && apt-get autoremove -y --purge \
    && rm -rf /var/lib/apt/lists/* /root/.npm /ms-playwright/ffmpeg-* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && chmod -R a+rX /ms-playwright

COPY --from=jre /opt/jre /opt/java/openjdk
COPY --from=verapdf /opt/verapdf/verapdf /opt/verapdf/verapdf
COPY --from=verapdf /opt/verapdf/bin /opt/verapdf/bin
COPY --from=verapdf /opt/verapdf/plugins /opt/verapdf/plugins
# veraPDF writes its default config folder on its first run. Run it once here,
# as root, so /opt/verapdf/config exists and is read-only for the scan user
# (the image also runs with a read-only root filesystem). Then: the scan user,
# and no setuid or setgid file left that a compromised scan could use.
RUN ln -s /opt/verapdf/verapdf /usr/local/bin/verapdf \
    && verapdf --version | grep -q 'veraPDF 1.30.3' \
    && test -f /opt/verapdf/config/validator.xml \
    && chmod -R a+rX,go-w /opt/verapdf \
    && groupadd --gid 10001 widedoor \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin widedoor \
    && mkdir /work && chown 10001:10001 /work \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} +

# Widedoor itself, last.
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/packages/core/data packages/core/data
COPY --from=build /src/packages/core/schema packages/core/schema
COPY --from=build /src/packages/web/dist packages/web/dist
COPY --from=build /src/packages/pdf/dist packages/pdf/dist
COPY --from=build /src/packages/report/dist packages/report/dist
COPY --from=build /src/packages/report/data packages/report/data
COPY --from=build /src/packages/report/schema packages/report/schema
COPY --from=build /src/packages/report/vendor/openacr packages/report/vendor/openacr
COPY --from=build /src/packages/server/dist packages/server/dist
# cli/dist without @widedoor/ai beside it: in the scan and hosted images, --ai-fixes and
# widedoor suggest fail by design (the AI module cannot load; D16).
COPY --from=build /src/packages/cli/dist packages/cli/dist
COPY --from=build /src/packages/ui/dist packages/ui/dist
COPY LICENSE NOTICE docker/THIRD-PARTY-NOTICES.txt ./

# The hosted scan machine (docker build --target scan). Its entry runs as root: it loads
# the firewall, starts the egress proxy as uid 10002 and the agent, which runs each scan
# as uid 10001 (docker/scan-entry.sh). nftables gives nft, which loads the firewall as
# native nftables (Fly's kernel has no xt owner match, so iptables' -m owner cannot load
# there), root only (0700); procps gives the agent's reaper pkill. apt ran after the setuid and setgid
# strip, so it runs again.
FROM base AS scan
RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends nftables procps \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/setpriv \
    && test -x /usr/bin/pkill \
    && test -x /usr/sbin/nft \
    && chmod 0700 /usr/sbin/nft \
    && groupadd --gid 10002 egress \
    && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin egress \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --chmod=0755 docker/scan-entry.sh /app/docker/scan-entry.sh
# Timed-out DNS lookups hold libuv threads; more of them keep the proxy resolving.
ENV UV_THREADPOOL_SIZE=32
ENTRYPOINT ["/app/docker/scan-entry.sh"]

# The hosted API (docker build --target hosted; packages/server/src/hosted/api-bin.ts).
FROM base AS hosted
USER 10001:10001
ENTRYPOINT ["node", "/app/packages/server/dist/hosted/api-bin.js"]

# The CLI, last so it stays the default target. Only this image gets AI fix suggestions:
# the cli workspace's production dependencies (a superset of the base's, from the same
# lockfile) and @widedoor/ai, which the CLI loads only when AI is turned on.
FROM base AS cli
COPY --from=deps-cli /app/node_modules node_modules
COPY --from=deps-cli /app/packages/ai/package.json packages/ai/
COPY --from=build /src/packages/ai/dist packages/ai/dist
COPY --from=build /src/packages/ai/schema packages/ai/schema
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["node", "/app/packages/cli/dist/bin.js"]
CMD ["--help"]
