# Security Policy

## Supported versions

Security fixes are provided for the latest release on the `main` branch and the most recent tagged release.

| Version | Supported |
| ------- | --------- |
| latest tagged release | yes |
| `main` | yes |
| older tags | no |

## Reporting a vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Use one of these channels:

1. **GitHub private vulnerability reporting** — [Report a vulnerability](https://github.com/vyotiqai/vyotiq-agent-v/security/advisories/new) on this repository (preferred).
2. **Email** — security@vyotiq.com (if private reporting is unavailable).

Include:

- Description of the issue and impact
- Steps to reproduce
- Affected versions or commits
- Proof of concept, if available

We aim to acknowledge reports within **3 business days** and will coordinate disclosure after a fix is available.

## Secure development

- API keys are stored with Electron `safeStorage`; never commit secrets.
- CI runs `pnpm audit --audit-level high` on every change.
- Secret scanning and push protection are enabled on this repository.
- Dependabot security updates are enabled.

## Security updates

Subscribe to [GitHub Releases](https://github.com/vyotiqai/vyotiq-agent-v/releases) for patched builds.
