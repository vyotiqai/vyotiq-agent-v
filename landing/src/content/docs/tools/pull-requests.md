---
title: Pull requests and GitHub
description: Connect GitHub, satisfy repository prerequisites, and create or inspect a pull request from the dock.
section: tools
order: 5
type: guide
audience: GitHub users
related:
  - tools/changes-git
  - troubleshooting/git-pull-requests
  - reference/settings
---

The Pull Request panel uses Git and the GitHub CLI (gh) to connect an active workspace to GitHub.

## Prerequisites

The workspace must:

- be a Git repository;
- have at least one commit;
- be on a branch that can be published;
- have a usable GitHub remote, or allow the creation flow to establish one;
- have gh available and authenticated.

The in-app device flow uses the app's built-in GitHub OAuth App client ID. No user-supplied client ID or environment variable is needed; the app does not read `VYOTIQ_GITHUB_CLIENT_ID`.

## Connect and open a pull request

1. Open Pull Request.
1. If shown, complete Connect GitHub.
1. Resolve any GitHub CLI not found, repository, remote, or initial-commit state.
1. Refresh the panel.
1. Create a draft pull request from the current topic branch, or open the existing pull request.

The panel can show Changes, Description, Commits, Checks, and Reviews for an available pull request. "Checks completed" is not equivalent to passed; the panel counts successful conclusions separately.

## Repository creation boundary

When no matching remote exists, the creation flow can connect or create a private GitHub repository. Read the confirmation carefully because repository creation and push are external mutations.

## Authentication safety

Do not paste access tokens into chat, rules, or skill files. Use the connection flow or the GitHub CLI's own authentication storage.

## Recover from an empty panel

The panel maps failures to actionable states such as GitHub CLI not found, Not a git repository, GitHub repository not configured, No commits yet, and GitHub authentication required. Follow the state in that order instead of repeatedly pressing refresh. Full recovery is in [Git and pull-request issues](/docs/troubleshooting/git-pull-requests).
