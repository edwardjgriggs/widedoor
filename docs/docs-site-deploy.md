# Deploying the docs site

This runbook is for the person who deploys the Widedoor docs site to Vercel. The site itself
leaves it out (it is an operator runbook, like `hosted-runbook.md`).

The site is static: `npm run docs:build` turns `README.md` and `docs/*.md` into HTML in
`packages/docs/dist`, with no script. `vercel.json` at the repository root tells Vercel how to
build and serve it.

## Rules for every step

- **Every command below needs Edward's OK before it runs.** Each one creates, changes or
  removes something on Vercel or the public web. Nothing in this repository runs them on its
  own, and no CI job deploys the site.
- **Never paste a Vercel token into a chat, an issue, a commit or a log.** Sign in with
  `vercel login` in your own terminal, or keep a token in your own environment only.
- The site uses the free `*.vercel.app` subdomain (D24). No custom domain is set up here.

## What the build does

Vercel reads `vercel.json` only from the project's **Root Directory**, so the file sits at the
repository root and the Root Directory stays the repository root. The headers and clean URLs
come only from that file; nothing in the dashboard sets them.

- The `installCommand` is
  `npm ci --ignore-scripts --workspace @widedoor/docs --include-workspace-root`, so Vercel's own
  default install never runs. It installs from the lockfile only the docs workspace and the
  root (which holds `tsx`), and runs no install script of any package.
- The `buildCommand` is `npm run docs:build`. It writes `packages/docs/dist`, and it is not part
  of `npm run build`.
- `outputDirectory` is `packages/docs/dist`, `framework` is `null` and `cleanUrls` is on, so
  `/usage/` serves `usage/index.html`.
- Every path gets these headers:
  - `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  - `Cross-Origin-Opener-Policy: same-origin`

Check the build locally first (no OK needed; it touches nothing outside the clone):

```sh
npm ci --ignore-scripts --workspace @widedoor/docs --include-workspace-root
npm run docs:build
```

## First deploy

Use one of the two ways. Each step needs Edward's OK.

**From the Vercel dashboard (recommended).**

1. Needs Edward's OK. In the Vercel dashboard, import the GitHub repository
   `edwardjgriggs/widedoor` as a new project.
2. Needs Edward's OK. Leave **Root Directory** as the repository root (empty), and the
   framework preset as **Other**. Do not override the build command, output directory or
   headers in the dashboard: `vercel.json` sets them.
3. Needs Edward's OK. Deploy.

**From a clone with the Vercel CLI.**

1. Needs Edward's OK. Sign in: `vercel login`.
2. Needs Edward's OK. Link the clone to a new project, from the repository root:
   `vercel link`.
3. Needs Edward's OK. Deploy to production, from the repository root: `vercel deploy --prod`.

## Check the deploy

1. Open the `*.vercel.app` address Vercel gives the project. Check that it is a Vercel
   subdomain (D24) and that the home page, a section page such as `/usage/` and a missing
   page (the 404 page) load.
2. Confirm the headers (read only; no OK needed):

   ```sh
   curl -I https://<project>.vercel.app/
   curl -I https://<project>.vercel.app/usage/
   ```

   Each answer must carry the five headers above, exactly.

   **If the headers are missing,** Vercel did not read `vercel.json`. The usual cause is a
   Root Directory other than the repository root, so the file is not at the Root Directory.
   Set the Root Directory back to the repository root (needs Edward's OK), redeploy (needs
   Edward's OK) and check again. Do not leave a deploy without its headers live: remove it, or
   roll back to one that has them (each needs Edward's OK).

3. Optionally, scan the live site with Widedoor itself:
   `widedoor scan https://<project>.vercel.app/ --out widedoor-report/docs-site`. The browser
   test (`packages/docs/test/site.browser.test.ts`) already requires no fail on every page.

## Update

A push to the default branch redeploys the project if the Git integration is on. Turning
that integration on or off is a project setting and needs Edward's OK.

## Remove the project

1. Needs Edward's OK. In the dashboard, open the project, then **Settings**, **Advanced**,
   **Delete Project**. With the CLI: `vercel project rm <project>`.
2. Check that the `*.vercel.app` address no longer serves the site.
