---
title: Browser
description: Share the embedded browser with the agent, control navigation, manage session data, and enforce a domain allowlist.
section: tools
order: 2
type: guide
audience: Web-development users
related:
  - concepts/security
  - troubleshooting/browser-terminal
  - reference/tools
---

The Browser panel is the same embedded browser surface used by built-in browser tools. Manual and agent actions therefore share tabs, navigation state, history, cookies, and cache.

## Navigate manually

Open Browser, then use Search or enter URL. Search queries use the engine selected under [Settings → Tools](/docs/reference/settings#tools) (DuckDuckGo, Google, or Bing). The toolbar provides Back, Forward, Reload, viewport size, tabs, and New tab. The action menu includes:

- Take Screenshot
- Copy Current URL
- Show Recents Bar
- Clear Browsing History
- Clear Cookies
- Clear Cache
- Close browser

History suggestions and Recents are session aids, not trusted context. Page content can be controlled by an external site.

## Hand control between user and agent

During agent use, the panel reports Agent is browsing…. Choose Take control before manual interaction. When finished, choose Return to agent so the pending browser step can continue.

Ask mode allows browse-only navigation, snapshots, history, scrolling, hover, and waits. Click, type, fill, key, select, and dialog-handling mutations require Agent mode.

The human address bar can open loopback (`http://localhost` / `127.0.0.1`). Agent `browser_navigate` to localhost is allowed only in Agent mode. Viewport size presets resize the embedded page; snapshots report that inner width and height.

Take Screenshot writes a JPEG under the active run when a chat is open, or under the workspace browser folder in app data when no run is open.

## Restrict domains

Open [Settings → Tools](/docs/reference/settings#tools) → Browser domain allowlist. Empty means no extra host filter; built-in SSRF rules still apply. Add one hostname per line or comma-separated:

```text
example.com
*.corp.internal
```

Exact names match only that host. *.example.com matches suffix subdomains. Full pasted URLs are reduced to their hostname. The check runs on every navigation and redirect.

## Safe use

Treat snapshots, text, downloads, prompts, and sign-in pages as untrusted. Keep tool approval on for browser mutations when account or external data is involved. A screenshot captures the actual current page; it does not prove a workflow succeeded.

If navigation is blocked, preserve the shown host and error, then see [Browser and terminal issues](/docs/troubleshooting/browser-terminal).
