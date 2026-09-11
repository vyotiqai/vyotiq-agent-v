# Agent V site

Static site for Agent V (Vyotiq is the company; Agent V is the product). Astro 7 + Tailwind 4. Client JavaScript is limited to theme toggling and documentation controls.

## Local

From the repo root:

```bash
pnpm install
```

```bash
pnpm landing:dev
```

Production build (output: landing/dist/):

```bash
pnpm landing:build
```

```bash
pnpm --filter @vyotiq/landing preview
```

## Routes

| Path | What it is |
| --- | --- |
| / | Product overview |
| /docs | Product manual |
| /changelog | Release notes baked from GitHub Releases |
| /privacy | Website privacy |
| /terms | Terms of Service |
| /products/agent-v | Redirects to / |

Other /docs/... redirects in astro.config.mjs are aliases onto the current manual tree.

Copy landing/.env.example to landing/.env to override the canonical site URL:

PUBLIC_SITE_URL=https://vyotiq.com

Optional cookieless analytics uses PUBLIC_ANALYTICS_SRC and PUBLIC_ANALYTICS_DOMAIN. Leave both unset to ship no tracker. Production builds fetch the latest GitHub Releases at build time (pnpm bake:landing-release, also run by landing/package.json's build script) to bake the download buttons and the /changelog page — never in the browser. A failed fetch keeps the previously baked snapshots.

## Brand sync

Brand files under landing/public/brand/ are copied from resources/branding/ by pnpm sync:landing-brand (runs automatically before landing:dev / landing:build). That sync copies the canonical transparent mark and wordmark for chrome, the purpose-built monochrome social card as og.png, the app icon as favicon, and maintained Mono provider marks (the same glyphs as the composer picker) into landing/src/assets/providers/.

## Hosting (Cloudflare Pages)

Deployed to Cloudflare Pages (project `vyotiq`, production branch main) by .github/workflows/deploy-landing.yml via wrangler. The workflow runs pnpm landing:build then pages-deploys landing/dist; it needs repo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The Release workflow re-dispatches it automatically after each tagged release, so download buttons and /changelog stay current. It can also be run manually with gh workflow run deploy-landing.yml.
