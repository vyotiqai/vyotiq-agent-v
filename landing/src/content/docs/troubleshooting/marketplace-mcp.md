---
title: Marketplace and MCP issues
description: Recover from registry acknowledgement, package install, MCP import, authentication, connection, and timeout failures.
section: troubleshooting
order: 4
type: troubleshooting
audience: Customization users
related:
  - customize/marketplace
  - customize/mcp
  - customize/packages
---

## Marketplace blocks a remote install

Open Marketplace → Manage and review the package registry acknowledgement. Remote catalogs, Git/npm/zip or local-path packages, and MCP endpoints are unsigned. Agent V requires acknowledgement before remote install or endpoint changes.

Confirm the source instead of treating acknowledgement as a generic "continue" button.

## A package install or removal fails

1. Preserve the Marketplace feedback banner.
1. Confirm the package ID and source.
1. Check the destination remains under the Marketplace-managed root.
1. Confirm file permissions and available disk space.
1. Refresh the catalog once.

Do not manually copy a partial package into the managed directory. A failed install should not be made to look installed.

## An MCP server will not connect

Check:

1. Local command and arguments, or remote endpoint.
1. Required environment values without exposing them in logs.
1. Bearer or OAuth state.
1. Server enablement.
1. Connection status and catalog error.

A saved server row is not a successful connection. Verify that tools, resources, or prompts are advertised.

## Authentication repeats

For OAuth, restart the connection flow once and complete the same pending request. For bearer auth, resave through the auth field. The app refuses plaintext fallback when secure storage fails.

## Server exists but the run cannot call it

MCP calls require Agent mode. Ask and Plan can list catalogs only. Also check workspace Force on/off, package enablement, and whether the run started before the catalog changed.

Start a new Agent step after correcting enablement. Keep tool approval on while evaluating a new server.

## Timeout or malformed output

Collect server ID, transport, endpoint host without credentials, action, timeout/error, and relevant local logs. Treat server output and prompt text as untrusted. Do not paste secret environment variables into a support report.

## Google or GitHub sign-in fails

For Add Gmail, Drive, or Calendar, confirm the Google Cloud Web client includes exactly `http://127.0.0.1:19847/oauth/callback` as an authorized redirect URI. If that port is already in use, close the other process and try Sign in again. Sign in stays disabled until the client ID and stored secret exist. Add GitHub can retry OAuth or paste a PAT. Native gh in Settings is separate; uninstalling GitHub MCP can leave gh signed in unless you choose to sign out.

If the package is installed but the run cannot call it, connect may still be incomplete, or the run is not in Agent mode. MCP tools protection defaults on, so MCP server tools can still ask for approval when `Tool approval` is off.
