---
title: Install Agent V
description: Install Agent V on Windows, macOS, or Linux, or build the packaged app from source and verify the runtime.
section: start
order: 2
type: quickstart
audience: New users
related:
  - start/quickstart
  - concepts/privacy-data
---

The Agent V homepage has a download button that takes you to the release page with the latest installers for Windows, macOS, and Linux. There is no app store listing.

Installers and the Start-menu shortcut are named Vyotiq — Agent V is the assistant inside that app. Electron is the packager and runtime, not the product name.

To run a local pnpm dev session, or pack an installer from this repository with electron-builder (`--publish never`), build from source.

## Build from source

You need pnpm, a folder you can use as a workspace, and at least one model provider you can configure after launch. Cloud providers require their own API key. Local Ollama and a private or loopback Custom OpenAI-compatible endpoint can be used without a key.

Packaging does not write a cloud API key. New settings start on local Ollama with `qwen2.5` — see Quickstart for what that does and does not guarantee. Provider setup happens in [Settings → Providers](/docs/customize/providers).

From the repository root:

```bash
pnpm install
```

For day-to-day development without an installer, pnpm dev is enough. Continue with [the first useful run](/docs/start/quickstart).

## Pack an installer

Scripts in package.json run pnpm build then electron-builder. Default output is dist-package/. If that directory is locked (EBUSY), use the :alt scripts, which write to dist-package-alt/.

| Script | Target | Artifact name (1.0.0) |
| --- | --- | --- |
| `pnpm pack:win` | Windows NSIS | Vyotiq-1.0.0-setup.exe |
| `pnpm pack:mac` | macOS DMG | Vyotiq-1.0.0-<arch>.dmg |
| `pnpm pack:linux` | Linux AppImage | Vyotiq-1.0.0.AppImage |
| `pnpm pack:dir:win` | Unpacked Windows dir | win-unpacked/ with Vyotiq.exe |

Names come from electron-builder.yml:

- Windows NSIS: ${productName}-${version}-setup.${ext}
- macOS DMG: ${productName}-${version}-${arch}.${ext}
- Linux AppImage: ${productName}-${version}.${ext}

productName is Vyotiq. version is the root package.json version.

## Install on Windows

1. Pack with `pnpm pack:win` (or pack:win:alt).
1. Run Vyotiq-1.0.0-setup.exe from the output directory.
1. Choose the installation directory when the installer asks.
1. Launch Vyotiq from the Start menu or desktop shortcut.

The installer is per-user (perMachine: false), creates Start menu and desktop shortcuts named Vyotiq, and can launch the app when setup finishes (runAfterFinish: true). Uninstalling does not delete the app-data directory (deleteAppDataOnUninstall: false).

## Install on macOS

1. Pack with `pnpm pack:mac`.
1. Open Vyotiq-1.0.0-<arch>.dmg and install the application.
1. Launch Vyotiq.

The current package configuration leaves notarize: false for local packs. GitHub Releases notarize the macOS DMG only when Apple ID, app-specific password, and team ID secrets are present at pack time. Unsigned builds can require an explicit Gatekeeper confirmation before first launch.

## Install on Linux

1. Pack with `pnpm pack:linux`.
1. Mark Vyotiq-1.0.0.AppImage executable using your desktop file manager or shell.
1. Run the AppImage.

The packaged application targets the system architecture used for the pack. There is no repository-level claim that every Linux distribution is supported.

## Verify the installation

Open Settings → About. The page shows the Vyotiq version, Electron, Chromium, Node.js, platform, and architecture. The Copy button copies that build information for support.

Continue with the first useful run. If the app opens but a run cannot start, use [Provider and model issues](/docs/troubleshooting/providers-models).
