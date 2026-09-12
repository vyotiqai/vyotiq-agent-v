---
title: Marketplace overview
description: Use Browse for registry packages and Manage for MCPs, Skills, Rules, and installed Packages.
section: customize
order: 3
type: concept
audience: Customization users
related:
  - customize/mcp
  - customize/skills
  - customize/rules
  - customize/packages
---

Marketplace is the customization hub. It has two jobs: browse packages from a configured registry and manage the local systems already available to the app.

## Browse

The Marketplace home shows registry content when a registry is configured and acknowledged. A package can contain supported customization assets. Registry trust matters because installed content can influence agent behavior or connect external systems.

Read the package description and contents before installing. Installed packages appear in Manage without restarting the app.

## Manage

Open Marketplace → Manage. The exact tabs are:

- **MCPs**
- **Skills**
- **Rules**
- **Packages**

These are not aliases:

- **MCPs** connect local or remote Model Context Protocol servers.
- **Skills** are SKILL.md instruction packages the agent can load.
- **Rules** are user or workspace behavior instructions.
- **Packages** bundle installable Marketplace content and lifecycle state.

## Scope and workspace overrides

Global enablement applies app-wide. For eligible **MCPs** and **Packages**, Force on/off can create a workspace override that wins for agent runs in that workspace. Global MCP connections stay available for other workspaces.

Workspace overrides are managed with the workspace's Override state under [Settings → General](/docs/reference/settings) → Workspaces.

## Live updates

Created or edited **Skills** and **Rules** are picked up through live refresh paths. Installed or removed packages update in Manage without a restart.

## Security boundary

A visible listing is not an endorsement of every server, prompt, rule, or package. Review registry acknowledgement, server transport and auth, package contents, and workspace scope. MCP server tool calls remain Agent-only and can still be gated by tool approval.

Use the focused pages for setup and failure recovery. Start with MCP servers for integrations and **Packages** and workspace overrides for install lifecycle.

## Discover GitHub and Google

Browse includes a Discover row of larger cards. The catalog is GitHub, Gmail, Google Drive, and Google Calendar. Add on a card installs that MCP and opens Connect.

Add GitHub uses Sign in with OAuth, or paste a personal access token when OAuth is unavailable. Native GitHub in the Pull Request panel stays separate from GitHub MCP.

Add Gmail (and Drive or Calendar) requires a one-time Google Cloud Web client with a fixed redirect URI. Follow the Google setup in [MCP servers](/docs/customize/mcp) before the first Connect.

MCP server tools run in Agent mode. MCP tools protection defaults on under [Settings → Tools](/docs/reference/settings#tools).
