---
title: Files editor
description: Browse and edit workspace files, handle external changes, and use diff, blame, LSP, and formatting integrations.
section: tools
order: 1
type: guide
audience: Users editing in the app
related:
  - tools/changes-git
  - agent/checkpoints
  - troubleshooting/runs-network-recovery
---

The Files panel is a workspace tree and editor. It is separate from agent memory and from the Changes diff viewer.

## Browse and manage entries

Open Files from the dock rail. The tree supports New file, New folder, Refresh, Rename, Duplicate, and Delete permanently according to the selected entry. Path actions include Copy relative path, Copy absolute path, Open externally, and Reveal in file manager.

Deletion is permanent. Symlinks and workspace boundaries restrict mutation actions.

## Edit and save

Opening a file creates an editor tab. A dirty text tab can use Save, Discard/Reload, and Close tab. View and behavior options include:

- Line numbers
- Word wrap
- Auto Save
- Format on Save

For images (PNG, JPEG, GIF, WebP, SVG) the tab opens a rendered preview. Markdown and HTML files keep the source editor and add a Preview control. HTML preview is sandboxed (no scripts, no same-origin). Binary files that are not images still use the hex editor.

Discard/Reload abandons the editor buffer or reloads a file changed on disk. It is not the same as checkpoint Discard in Changes.

## Resolve an external change

When the file changes on disk while your tab is dirty, the tab enters a conflict state. Normal Save is disabled.

1. Compare the editor buffer with the disk change.
1. Choose Discard/Reload to accept disk state, or Overwrite external changes only when your buffer is authoritative.
1. Save and verify the resulting file.

Do not overwrite merely to remove the warning; an agent or external editor may have produced newer work.

## Integrations

The editor actions can open Diff View, LSP, and Git Blame when their backing service is available. Format on Save remains disabled when no formatter is detected. These integrations report unavailability instead of silently pretending to run.

## Recovery

Editor session state can retain open tabs and view preferences, but the workspace file on disk is authoritative. Use Git and checkpoint review for durable recovery. If a file cannot open, confirm it remains inside the selected workspace and is a supported regular file.
