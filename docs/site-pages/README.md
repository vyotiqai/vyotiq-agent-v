# Pages from the removed websites

vyotiq.com was removed on 2026-09-27 so a new site can be built from scratch.
These are the page files of the two versions that existed, kept for reference.
They are not built or linted, and they will not run on their own.

- `old/` is the site that was live at vyotiq.com until then (`landing/` on `main`).
- `new/` is the redesign that was never merged (PR #21).

Most of the wording on both sites lives in `showcase.ts`, not in the pages: every
feature claim, and on the new site the home page's headings and rows too. That
file is here beside each set of pages for that reason.

Everything else (components, styles, scripts, fonts, the painting, screenshots
and clips) is in git under two tags:

```bash
git show archive/site-old:landing/<path>
git show archive/site-new:landing/<path>
git worktree add ../site-new archive/site-new   # the whole redesign, checked out
```
