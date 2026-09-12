---
title: Packages and workspace overrides
description: Install, update, enable, remove, and scope Marketplace packages without confusing global and workspace state.
section: customize
order: 7
type: guide
audience: Marketplace users
related:
  - customize/marketplace
  - troubleshooting/marketplace-mcp
  - concepts/privacy-data
---

**Packages** are installed Marketplace bundles. Manage them in Marketplace → Manage → **Packages**.

## Registry trust

Before browsing or installing registry content, review the registry URL and acknowledgement shown by Marketplace. **Packages** can contain behavior-changing assets such as skills, rules, or integration definitions. Install only content whose source and scope you accept.

## Lifecycle

An installed package can expose install state, version state, enablement, update, and removal actions. Use the visible action for that row rather than manually editing the package store.

After an install, update, enable, disable, or removal, the Manage list and affected discovery surfaces refresh without an app restart.

## Global versus workspace state

Global enablement is the default for all workspaces. When a workspace is active and overrides are available, Force on/off writes a workspace-specific decision that wins for agent runs in that workspace.

The Manage notice states:

Force on/off enables workspace overrides for this workspace and overrides global package enablement for agent runs here.

The override belongs to the workspace settings record under [Settings → General](/docs/reference/settings) → Workspaces. Clearing the override returns to global behavior.

## Remove safely

Before removal:

1. Check which skills, rules, or server definitions the package supplied.
1. Finish or stop runs that depend on them.
1. Remove through Marketplace.
1. Confirm the row and related catalogs update.

Removing a package does not reverse side effects previously performed by a tool or external service.

## Recovery

If installation fails, preserve the Marketplace feedback message. Verify registry acknowledgement, package identifier, destination safety, and write permissions. For imported MCP content, also inspect the MCP connection state. Use Marketplace and MCP issues for ordered recovery.
