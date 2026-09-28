#!/usr/bin/env python3
"""tweak.py - put the tweak panel on a page, take it off, and bake the results back.

Part of the design-level-up skill (Advanced, trick 23). Standard library only.

  python tweak.py inject page.html [--src path/or/url/to/tweak-panel.js]
      Adds the panel between marker comments, just before </body>. Without --src the
      panel is inlined, so it also works when the page is opened from disk (file://).

  python tweak.py remove page.html
      Deletes everything between the markers again.

  python tweak.py bake tweaks.json styles.css [more.css page.html ...] [--scheme light|dark] [--dry-run]
      Reads the JSON exported by the panel ("Save JSON" / "Copy JSON" / tweaks.export())
      and rewrites the matching custom-property declarations inside :root / html rules.
      HTML files are searched inside their <style> blocks. Values are replaced in place,
      so comments, ordering and formatting survive. Tokens that are not declared in any
      file are listed for you to add by hand; hidden elements are listed for you to
      delete from the source (the script never guesses at markup).

  python tweak.py selftest
      Runs the built-in checks.

Exit codes: 0 ok, 1 something was not applied (missing tokens), 2 usage or input error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
PANEL_JS = HERE.parent / "assets" / "tweak-panel.js"
START = "<!-- tweak-panel:start -->"
END = "<!-- tweak-panel:end -->"
ROOT_SELECTOR = re.compile(r"(^|,)\s*(:root|html)\b", re.I)
DARK = re.compile(r"dark", re.I)


# ---------------------------------------------------------------- file helpers
def read_text(path: Path) -> tuple[str, str]:
    """Return (text, newline) without translating newlines, so writes round-trip."""
    with open(path, encoding="utf-8", newline="") as fh:
        text = fh.read()
    newline = "\r\n" if "\r\n" in text else "\n"
    return text, newline


def write_text(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


# ---------------------------------------------------------------- inject/remove
def inject(page: Path, src: str | None) -> int:
    text, nl = read_text(page)
    if START in text:
        print(f"{page}: the panel is already injected. Run 'remove' first to refresh it.")
        return 0
    if src:
        tag = f'<script src="{src}" data-tweak-panel defer></script>'
    else:
        if not PANEL_JS.exists():
            print(f"error: {PANEL_JS} not found; pass --src instead", file=sys.stderr)
            return 2
        js = PANEL_JS.read_text(encoding="utf-8").replace("</script", "<\\/script")
        tag = "<script data-tweak-panel>" + nl + js.replace("\r\n", "\n").replace("\n", nl) + nl + "</script>"
    block = START + nl + tag + nl + END + nl
    idx = text.lower().rfind("</body>")
    text = text[:idx] + block + text[idx:] if idx != -1 else text + nl + block
    write_text(page, text)
    print(f"{page}: panel injected ({'linked' if src else 'inlined'}). Open the page and use the panel "
          f"in the bottom-right corner; Alt+Shift+T toggles it.")
    return 0


def remove(page: Path) -> int:
    text, _ = read_text(page)
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END) + r"(\r?\n)?", re.S)
    new, count = pattern.subn("", text)
    if not count:
        print(f"{page}: no panel markers found, nothing to remove.")
        return 0
    write_text(page, new)
    print(f"{page}: panel removed.")
    return 0


# ---------------------------------------------------------------- CSS scanning
@dataclass
class Rule:
    context: tuple[str, ...]  # enclosing preludes, outermost first (e.g. "@media (...)")
    selector: str
    body_start: int
    body_end: int


def _strip_comments(s: str) -> str:
    return re.sub(r"/\*.*?\*/", "", s, flags=re.S)


def iter_rules(css: str):
    """Yield every style rule with its selector, body span and at-rule context.

    A small brace matcher that skips comments and strings: enough for token files,
    not a general CSS parser.
    """
    i, n = 0, len(css)
    stack: list[tuple[str, int]] = []
    prelude_start = 0
    while i < n:
        if css.startswith("/*", i):
            j = css.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        c = css[i]
        if c in "\"'":
            j = i + 1
            while j < n and css[j] != c:
                j += 2 if css[j] == "\\" else 1
            i = j + 1
            continue
        if c == "{":
            prelude = " ".join(_strip_comments(css[prelude_start:i]).split())
            stack.append((prelude, i + 1))
            prelude_start = i + 1
        elif c == "}":
            if stack:
                prelude, body_start = stack.pop()
                if not prelude.startswith("@"):
                    yield Rule(tuple(p for p, _ in stack), prelude, body_start, i)
            prelude_start = i + 1
        elif c == ";":
            prelude_start = i + 1
        i += 1


def css_segments(path: Path, text: str) -> list[tuple[int, int]]:
    """Spans of CSS inside a file: the whole file for stylesheets, <style> blocks for HTML."""
    if path.suffix.lower() in {".html", ".htm", ".svelte", ".vue", ".astro"}:
        return [(m.start(1), m.end(1)) for m in re.finditer(r"<style\b[^>]*>(.*?)</style\s*>", text, re.S | re.I)]
    return [(0, len(text))]


@dataclass
class Candidate:
    path: Path
    start: int  # value span inside the full file text
    end: int
    dark: bool
    in_media: bool
    selector: str


def find_candidates(path: Path, text: str, name: str) -> list[Candidate]:
    decl = re.compile(
        r"(?:^|(?<=[;{\s]))" + re.escape(name) + r"\s*:\s*(?P<val>[^;{}]*?)(?P<imp>\s*!important)?\s*(?=;|}|$)",
        re.S,
    )
    out: list[Candidate] = []
    for seg_start, seg_end in css_segments(path, text):
        css = text[seg_start:seg_end]
        for rule in iter_rules(css):
            if not ROOT_SELECTOR.search(rule.selector):
                continue
            body = css[rule.body_start:rule.body_end]
            for m in decl.finditer(body):
                if not m.group("val").strip():
                    continue
                out.append(Candidate(
                    path=path,
                    start=seg_start + rule.body_start + m.start("val"),
                    end=seg_start + rule.body_start + m.end("val"),
                    dark=bool(DARK.search(rule.selector) or any(DARK.search(c) for c in rule.context)),
                    in_media=any(c.lower().startswith("@media") for c in rule.context),
                    selector=" ".join(rule.context + (rule.selector,)),
                ))
    return out


def choose(cands: list[Candidate], scheme: str) -> list[Candidate]:
    """Pick the declarations that express the value for the scheme that was on screen."""
    if len(cands) <= 1:
        return cands
    want_dark = scheme == "dark"
    preferred = [c for c in cands if c.dark == want_dark] or cands
    if not want_dark:
        plain = [c for c in preferred if not c.in_media]
        preferred = plain or preferred
    return preferred


# ---------------------------------------------------------------- bake
def load_export(path: Path) -> tuple[dict[str, str], list[dict], str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    raw_vars = data.get("vars", data) if isinstance(data, dict) else {}
    values: dict[str, str] = {}
    for name, v in raw_vars.items():
        if not str(name).startswith("--"):
            continue
        values[name] = str(v.get("to") if isinstance(v, dict) else v).strip()
    hidden = data.get("hidden", []) if isinstance(data, dict) else []
    scheme = data.get("scheme", "light") if isinstance(data, dict) else "light"
    return values, hidden, scheme


def bake(export_path: Path, files: list[Path], scheme_override: str | None, dry_run: bool) -> int:
    try:
        values, hidden, scheme = load_export(export_path)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {export_path}: {exc}", file=sys.stderr)
        return 2
    scheme = scheme_override or scheme
    texts = {}
    for f in files:
        if not f.exists():
            print(f"error: {f} not found", file=sys.stderr)
            return 2
        texts[f] = read_text(f)

    edits: dict[Path, list[tuple[int, int, str]]] = {f: [] for f in files}
    applied, missing = [], []
    for name, value in values.items():
        cands = [c for f in files for c in find_candidates(f, texts[f][0], name)]
        chosen = choose(cands, scheme)
        if not chosen:
            missing.append(name)
            continue
        for c in chosen:
            old = texts[c.path][0][c.start:c.end]
            edits[c.path].append((c.start, c.end, value))
            applied.append((name, old.strip(), value, c.path, line_of(texts[c.path][0], c.start), c.selector))

    if not dry_run:
        for f, spans in edits.items():
            if not spans:
                continue
            text = texts[f][0]
            for start, end, value in sorted(spans, reverse=True):
                text = text[:start] + value + text[end:]
            write_text(f, text)

    verb = "Would bake" if dry_run else "Baked"
    print(f"{verb} {len(applied)} declaration(s) for the {scheme} scheme:")
    for name, old, new, path, line, selector in applied:
        same = " (unchanged)" if old == new else ""
        print(f"  {name}: {old} -> {new}{same}   {path}:{line}  [{selector}]")
    if missing:
        print("Not declared on :root/html in these files - add them by hand:")
        for name in missing:
            print(f"  {name}: {values[name]}")
    if hidden:
        print("Hidden while reviewing - delete these elements from the source (match by the text):")
        for h in hidden:
            print(f"  {h.get('selector', '?')}   {h.get('text', '')}")
    return 1 if missing else 0


# ---------------------------------------------------------------- selftest
SAMPLE_CSS = """/* tokens */
:root {
  --color-accent: #e85d2a;
  --radius-md: 12px;
  --space-4: 1rem; /* base */
  --font-display: "Fraunces", Georgia, serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --color-accent: #ff8a5c; }
}
:root[data-theme="dark"] { --color-accent: #ff8a5c; }
.card { --radius-md: 4px; border-radius: var(--radius-md); }
"""

SAMPLE_HTML = """<!doctype html><html><head><style>
html { --text-base: 16px }
</style></head><body><p>hi</p></body></html>
"""


def selftest() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        css, page, export = tmpd / "tokens.css", tmpd / "page.html", tmpd / "tweaks.json"
        css.write_text(SAMPLE_CSS, encoding="utf-8")
        page.write_text(SAMPLE_HTML, encoding="utf-8")

        export.write_text(json.dumps({
            "scheme": "light",
            "vars": {
                "--color-accent": {"from": "#e85d2a", "to": "#ff6b1a"},
                "--radius-md": {"from": "12px", "to": "16px"},
                "--text-base": {"from": "16px", "to": "17px"},
                "--space-9": {"from": None, "to": "4rem"},
            },
            "hidden": [{"selector": "main > section:nth-of-type(3)", "text": "<section> Loved by teams"}],
        }), encoding="utf-8")
        rc = bake(export, [css, page], None, dry_run=False)
        out_css, out_html = css.read_text(encoding="utf-8"), page.read_text(encoding="utf-8")
        assert rc == 1, "a missing token should give exit code 1"
        assert "--color-accent: #ff6b1a;" in out_css, "light :root value should change"
        assert out_css.count("#ff8a5c") == 2, "dark values must stay untouched in light scheme"
        assert "--radius-md: 16px;" in out_css and "--radius-md: 4px;" in out_css, ":root only, not .card"
        assert "--space-4: 1rem; /* base */" in out_css, "untouched lines and comments survive"
        assert "--text-base: 17px" in out_html, "<style> blocks in HTML are baked too"

        export.write_text(json.dumps({"scheme": "dark", "vars": {"--color-accent": "#ffa07a"}}), encoding="utf-8")
        rc = bake(export, [css], None, dry_run=False)
        out_css = css.read_text(encoding="utf-8")
        assert rc == 0
        assert out_css.count("#ffa07a") == 2 and "--color-accent: #ff6b1a;" in out_css, "dark scheme edits both dark blocks only"

        page.write_text(SAMPLE_HTML, encoding="utf-8")
        assert inject(page, None) == 0 and START in page.read_text(encoding="utf-8")
        assert "</body>" in page.read_text(encoding="utf-8").split(END, 1)[1], "panel goes before </body>"
        assert remove(page) == 0 and page.read_text(encoding="utf-8") == SAMPLE_HTML, "remove restores the page byte for byte"
    print("selftest ok")
    return 0


# ---------------------------------------------------------------- cli
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_inj = sub.add_parser("inject", help="add the panel to an HTML page")
    p_inj.add_argument("page", type=Path)
    p_inj.add_argument("--src", help="link this script URL/path instead of inlining the panel")
    p_rem = sub.add_parser("remove", help="take the panel off an HTML page")
    p_rem.add_argument("page", type=Path)
    p_bake = sub.add_parser("bake", help="write exported tweaks back into CSS/HTML")
    p_bake.add_argument("export", type=Path, help="JSON from the panel (Save JSON / Copy JSON)")
    p_bake.add_argument("files", type=Path, nargs="+", help="stylesheets or HTML files that declare the tokens")
    p_bake.add_argument("--scheme", choices=["light", "dark"], help="override the scheme recorded in the export")
    p_bake.add_argument("--dry-run", action="store_true", help="show the plan, change nothing")
    sub.add_parser("selftest", help="run built-in checks")
    args = ap.parse_args(argv)

    if args.cmd == "inject":
        return inject(args.page, args.src)
    if args.cmd == "remove":
        return remove(args.page)
    if args.cmd == "bake":
        return bake(args.export, args.files, args.scheme, args.dry_run)
    return selftest()


if __name__ == "__main__":
    sys.exit(main())
