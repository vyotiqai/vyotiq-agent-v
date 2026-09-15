# Privacy Policy

**Effective date:** 15 September 2026  
**Product:** Vyotiq (“Agent V”) — desktop application and the website at [vyotiq.com](https://vyotiq.com)  
**Publisher:** Vyotiq ([https://vyotiq.com](https://vyotiq.com), GitHub organization [vyotiqai](https://github.com/vyotiqai))

This policy describes what personal data the Agent V desktop app and the vyotiq.com marketing site handle, based on how the software is built today. It is not a substitute for reading the source code. The authoritative implementation lives in the [vyotiq-agent-v](https://github.com/vyotiqai/vyotiq-agent-v) repository.

## 1. Summary

- Agent V is a **local desktop app**. Your repositories, chats, API keys, workspace memory, and voice dictation are processed **on your machine** unless you choose to send data elsewhere (for example by using a third-party model provider with your own API key, or by turning on optional crash reporting).
- Optional crash and error reporting uses **Sentry**, only when a build includes a Sentry DSN **and** you enable “Share crash & error reports” in Settings. The default for that setting is **off**.
- The marketing site at vyotiq.com is a **static site**. This repository’s landing package does **not** embed third-party analytics scripts (no Google Analytics, Plausible, PostHog, or similar tags in the landing source).
- We do **not** operate a Vyotiq account system, Sign in, or hosted workspace for Agent V on this site.

## 2. Who this policy covers

- People who download, install, or run Agent V / Vyotiq.
- People who visit https://vyotiq.com and related pages published from this project.
- People who contact us (for example at security@vyotiq.com or via GitHub).

## 3. Data the desktop app keeps on your device

Agent V stores and processes data locally as part of normal operation, including:

| Category | Examples | Where it lives |
| --- | --- | --- |
| Workspace / code | Open repository paths, file contents the agent reads or edits | Your machine and the folders you open |
| Chat and agent runs | Messages, tool calls, run history | Local app state under Electron user data |
| Workspace memory | Notes the agent keeps for later runs | `.vyotiq/memory/` inside the workspace |
| Provider credentials | API keys for model providers you configure | Electron `safeStorage` (not committed to git) |
| Settings | Preferences including `telemetryEnabled` | Local settings store |
| Local logs & crash diagnostics | App logs; recent crash snippets | Local logs / diagnostics (always on-device; not the same as Sentry upload) |
| Voice dictation | Audio processed by the bundled Whisper path | Local processing in the app |

We (Vyotiq) do **not** receive the contents of your repositories, chats, API keys, or file bodies through Agent V unless a path below applies.

## 4. Data you send to third parties when you use the app

### 4.1 Model providers (bring your own keys)

Agent V talks to the model providers **you** configure, using **your** credentials. Prompts, code context, tool results, and related traffic go to those providers under **their** privacy policies and terms. Vyotiq does not sit in the middle as a hosted inference proxy for those requests.

### 4.2 Optional crash and error reporting (Sentry)

Packaged builds may include a Sentry DSN (`SENTRY_DSN` / `VITE_SENTRY_DSN`, documented in `.env.example` and the README). Crash reporting runs only when:

1. That DSN is present in the build, **and**
2. Settings → **Share crash & error reports** is enabled (`telemetryEnabled`; schema default is `false`).

When enabled, Sentry may receive diagnostic event data such as error types, scrubbed stack frames, release/version tags, environment (development vs production), and coarse tags (for example workspace count). The app configures `sendDefaultPii: false` and runs `beforeSend` scrubbing that removes exception message text, strips absolute paths from frames, and sanitizes breadcrumbs and log fields. The in-app help text states reporting does **not** include chat contents, API keys, or file bodies.

If the DSN is absent or telemetry is off, Sentry is not initialized and events are not uploaded.

Sentry is operated by Functional Software, Inc. (Sentry). See [https://sentry.io/privacy/](https://sentry.io/privacy/).

### 4.3 Software updates

Installers and update metadata are published to the companion releases repository [vyotiqai/vyotiq-agent-v-releases](https://github.com/vyotiqai/vyotiq-agent-v-releases). Checking for or downloading updates involves network requests to that distribution path (and underlying GitHub infrastructure). Those requests typically include standard connection metadata (IP address, user agent, and similar) processed by GitHub under its policies—not chat or repository contents.

### 4.4 Other network features

Features that reach the network (for example fetching provider models, downloading dictation assets, or opening links you click) send only what that feature needs to the destination you triggered. They are not a general-purpose telemetry pipeline.

## 5. The vyotiq.com website

The Agent V landing site is built as static pages from the `landing/` package in this repository.

- **No account.** There is no Sign in or user registration on the site.
- **No product analytics tags** in the landing source checked into this repository.
- **Hosting and CDN operators** (whoever serves vyotiq.com) and your browser may process standard server and connection logs (IP address, requested URL, user agent, referrer). That processing is controlled by the host, not by application code in this repo.
- **Downloads** may redirect or link to GitHub Releases / the releases repository; GitHub’s privacy policy applies to that traffic.

## 6. When you contact us

If you email security@vyotiq.com, use GitHub Security Advisories, or open GitHub issues/discussions, we process the content of your message and account metadata needed to respond (for example your GitHub username or email address). Security reports should follow [SECURITY.md](./SECURITY.md).

## 7. Cookies and similar technologies

The marketing pages in this repository do not set product analytics cookies. Your browser may still store ordinary site data for preferences such as theme if the page implements that locally. Third-party destinations you navigate to (GitHub, model providers, and so on) have their own cookie practices.

## 8. Children

Agent V and vyotiq.com are not directed at children under 16. We do not knowingly collect personal information from children.

## 9. Retention

- **On your device:** You control local data by deleting workspaces, clearing app data, or uninstalling the app.
- **Sentry (if you enabled reporting):** Retained according to the Sentry project configuration and Sentry’s practices for the organization that owns the DSN.
- **Email / GitHub contacts:** Kept as long as needed to handle the request and for legitimate security or legal records.

## 10. Your choices

- Leave **Share crash & error reports** off (default) to avoid Sentry uploads.
- Do not configure provider API keys if you do not want the app to call those providers.
- Build from source without a Sentry DSN so crash reporting cannot activate.
- Stop using the site or app at any time; uninstall removes the local application (workspace folders on disk remain until you delete them).

## 11. International transfers

If you enable Sentry or use cloud model providers, data you send may be processed in countries where those services operate. Review each provider’s documentation for transfer details.

## 12. Changes

We may update this policy when the product’s data practices change. The effective date at the top will change when we do. Material changes will be reflected in this `PRIVACY.md` file in the repository and on https://vyotiq.com/privacy.

## 13. Contact

- Privacy and security questions: **security@vyotiq.com**
- Preferred channel for vulnerabilities: [GitHub private vulnerability reporting](https://github.com/vyotiqai/vyotiq-agent-v/security/advisories/new) (see [SECURITY.md](./SECURITY.md))
- Source of truth for this document: `PRIVACY.md` in [vyotiqai/vyotiq-agent-v](https://github.com/vyotiqai/vyotiq-agent-v)

## 14. Relationship to other documents

- Software license: [LICENSE](./LICENSE) (GPL-3.0-or-later)
- Third-party notices: [NOTICE](./NOTICE)
- Security process: [SECURITY.md](./SECURITY.md)
- Website / download terms: [TERMS.md](./TERMS.md)
