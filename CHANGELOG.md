# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.3] - 2026-09-13

### Added

- Production-readiness hardening for the release pipeline: CHANGELOG-backed release notes, a tag/version gate, and a landing bake step that publishes current download URLs
- `SENTRY_DSN` secret wired into `build:vite` release builds

### Fixed

- Astro upgraded to the latest security release
- Test-pool reliability: capped concurrent sessions to stop flaky test runs
- Lint error blocking the CI gate
- Documentation accuracy pass: README, CONTRIBUTING, SECURITY, NOTICE, and CODE_OF_CONDUCT claims verified against the tree

### Changed

- Branding: nav and lockup updated to the Vyotiq brand mark
