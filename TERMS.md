# Terms of Use

**Effective date:** 19 September 2026
**Applies to:** the website at vyotiq.com and the distribution of Agent V installers
**Publisher:** Vyotiq — GitHub organization [vyotiqai](https://github.com/vyotiqai)

These terms cover the **website and how installers are distributed**. They do **not** replace
the software licence. They are written by the maintainers in plain language and are not legal
advice.

## 1. The software licence comes first

| Layer | Governed by |
| --- | --- |
| The Agent V application, its source and its binaries | [GPL-3.0-or-later](./LICENSE) |
| This website and the download distribution | These terms |
| Data handling | [PRIVACY.md](./PRIVACY.md) |
| Vulnerability reports | [SECURITY.md](./SECURITY.md) |
| Community spaces | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) |

If you use, modify, or redistribute Agent V, **GPL-3.0-or-later governs those rights**.
Nothing on this page reduces the freedoms the GPL grants you — including the right to run,
study, share, and modify the software. Where these terms and the GPL disagree about the
software, the GPL wins.

Third-party components carry their own licences, listed in [NOTICE](./NOTICE).

## 2. Downloads

Installers are published as GitHub release assets on
[vyotiqai/vyotiq-agent-v-releases](https://github.com/vyotiqai/vyotiq-agent-v-releases), which
is also the feed the in-app updater reads. The download pages on this site link to those
assets; GitHub serves the files.

Only download Agent V from this site or from that releases repository. Builds obtained
elsewhere are not published by us and we cannot make any statement about what they contain.

### Builds are currently unsigned

Releases are **not** code-signed on Windows and are **not** notarized on macOS. This is a
factual statement about the current build configuration, not an oversight we are hiding:

- **Windows** will show a SmartScreen warning on first run.
- **macOS** will refuse the first launch through Gatekeeper until you explicitly allow it.

If that is unacceptable for your environment, build from source — the repository is public
and the full build procedure is documented.

## 3. No warranty

Agent V is provided **as is, without warranty of any kind**, as set out in sections 15 and 16
of the GPL-3.0. That includes the website and the installers distributed through it.

Agent V is an agentic tool: it can run terminal commands, edit files, make git commits, open
pull requests, and drive a browser on your machine. **You are responsible for what you let it
do.** Review its proposed actions, keep your work in version control, and use the approval
controls the app provides. We are not liable for lost work, unintended changes, costs
incurred with model providers, or any other damages arising from your use of the software, to
the fullest extent the law allows.

## 4. Your model providers are your own agreements

The app talks to model providers using your API keys. Your use of those services is governed
by your agreement with each provider, including their terms, acceptable-use policies, and
billing. Vyotiq is not a party to that relationship and does not resell, proxy, or meter
model usage.

## 5. Acceptable use of this website

The site is static and public. Do not attempt to disrupt it, misrepresent your affiliation
with the project, or redistribute its content in a way that implies endorsement we have not
given.

## 6. Trade marks

The GPL licenses the code; it does not grant rights to the Vyotiq name or logo. You may use
them for accurate, nominative reference to this project — for example to say your tool
integrates with Agent V. Do not use them to brand a fork, or in a way that suggests we
published or endorsed something we did not. Forks are welcome and the GPL guarantees them;
they simply need to carry their own name and marks.

## 7. Third-party links

This site links to GitHub, model providers, and the vendors of extensions listed in the
marketplace. Those destinations are outside our control and carry their own terms and privacy
policies.

## 8. Changes

These terms are a file in the public repository. Changes are committed there, so what they
said and when is visible in git history.

## 9. Contact

<https://github.com/vyotiqai/vyotiq-agent-v/issues>, or the address in
[SECURITY.md](./SECURITY.md) for vulnerability reports.
