# Changelog

All notable changes to the Vyotiq desktop app and the website.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versioning follows [SemVer](https://semver.org/). This file is the single
source for the release notes shown in the in-app update card and on the
website changelog — a release must not ship without an entry here. Each
release's `###` subsections (for example `### Added`, `### Fixed`) become the
"About this update" sections users see.

## [1.2.1] - 2026-09-11

### Fixed

- The v1.2.0 installers crashed at launch on every platform ("A JavaScript error occurred in the main process: Cannot find module './encodingParams/o200k_harmony.js'") — an over-aggressive packaging trim removed gpt-tokenizer files the app loads at startup
- v1.2.0 installs cannot self-update (the app crashes before the update card runs) — install v1.2.1 manually from the website or GitHub Releases; v1.1.x installs update normally

## [1.2.0] - 2026-09-11

### Added

- The in-app update card now shows structured release notes ("What's new") for every release, pulled automatically from this changelog
- The app periodically checks for updates every 6 hours while running, in addition to the startup check
- "Full release notes" link on the update card opens the GitHub release page
- Website changelog page listing recent releases with their changes
- Website terms of service page
- Agent V is now open source under GPL-3.0 — build it from source and contribute on GitHub

### Changed

- Release notes are now automatic: the GitHub release body is generated from this changelog at publish time, so the update card always shows the recent changes
- Releases verify themselves after publishing — installers and updater metadata for Windows, macOS, and Linux must all be present — and the website redeploys automatically with fresh download buttons
- Feedback and support contact moved to support@vyotiq.com

## [1.1.4] - 2026-09-10

### Website

- Per-platform download buttons restored on the landing page

### Fixed

- svgo build-tooling override for GHSA-w27v-7q3p-w38r (high severity)

## [1.1.3] - 2026-09-09

### Desktop

- Memory tool: more reliable recall and storage of project decisions across sessions
- Evaluation harness adapter updates (internal quality tooling)

### Website

- The download button now detects your operating system and links the right installer
- New accessible theme switcher with light, dark, and system options
- Fixed a scroll dead-zone in the documentation sidebar and documentation layout issues
- Resolved 19 accessibility and compliance audit findings

## [1.1.2] - 2026-09-09

### Desktop

- Fixed a crash when checking for updates inside the app (update-state envelope handling)
- Blue is now the default accent color, with blue-tinted skin previews in appearance settings

## [1.1.1] - 2026-09-08

### Added

- In-app update experience: opt-in update card with download progress and install-and-restart
- Feedback dialog (Settings → General → Send feedback)

### Changed

- Installer size cut roughly in half (1397 MB → 710 MB unpacked) by shipping only the native libraries actually used; GPU inference preserved via Vulkan

### Fixed

- macOS packaging crash (plist/@xmldom compatibility)

## [1.1.0] - 2026-09-08

### Added

- First production release line: Windows and Linux installers (macOS followed in v1.1.1)

## [1.0.0] - 2026-08-24

### Added

- Initial release of Vyotiq (Agent V): coding workspace for real repositories
