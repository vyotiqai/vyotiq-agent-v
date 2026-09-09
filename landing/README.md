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
| /products/agent-v | Redirects to / |

Other /docs/... redirects in astro.config.mjs are aliases onto the current manual tree.

Copy landing/.env.example to landing/.env to override the canonical site URL:

PUBLIC_SITE_URL=https://vyotiq.com

Optional cookieless analytics uses PUBLIC_ANALYTICS_SRC and PUBLIC_ANALYTICS_DOMAIN. Leave both unset to ship no tracker. pnpm landing:dev and pnpm landing:build run bake:landing-release first on the build machine, never in the browser.

## Brand sync

Brand files under landing/public/brand/ are copied from resources/branding/ by pnpm sync:landing-brand (runs automatically before landing:dev / landing:build). That sync copies the canonical transparent mark and wordmark for chrome, the purpose-built monochrome social card as og.png, the app icon as favicon, and maintained Mono provider marks (the same glyphs as the composer picker) into landing/src/assets/providers/.

## Hosting (deferred)

landing/dist/ is static HTML/CSS/JS. When you pick a host:

| Host | Notes |
| --- | --- |
| GitHub Pages | withastro/action; set PUBLIC_SITE_URL. Use base only if the site is not at the domain root. |
| Cloudflare Pages | Build command pnpm landing:build, output landing/dist. |
| vyotiq.com | Point DNS at the chosen host; set PUBLIC_SITE_URL=https://vyotiq.com. |
