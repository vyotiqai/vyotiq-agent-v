#!/usr/bin/env python3
"""slop_check.py - a quick, zero-dependency scan for the tells of generic AI-made design.

Part of the design-level-up skill. Reads HTML, CSS and component files and flags what
usually makes a page look vibe-coded: default fonts, color and type-size sprawl, the
stock purple gradient, AI-sounding copy, placeholder text, emoji used as icons, and the
accessibility basics (alt text, focus styles, viewport, reduced motion).

It is a pre-flight check, not a verdict. Every finding says why it matters and which
trick fixes it. For a deeper audit use Impeccable (npx impeccable detect) when you can.

Usage:
  python slop_check.py PATH [PATH ...] [--banned-words FILE] [--json] [--fail-on error|warn|never]

  PATH            files or folders (node_modules, build output and minified files are skipped)
  --banned-words  one word or phrase per line (# comments ok), e.g. from your tone-of-voice skill
  --json          machine-readable output
  --fail-on       exit 1 when a finding at this level exists (default: error)

Exit codes: 0 clean at the chosen level, 1 findings at or above it, 2 usage error.
"""
from __future__ import annotations

import argparse
import colorsys
import json
import os
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

EXTS = {".html", ".htm", ".css", ".scss", ".sass", ".less", ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".mdx"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output",
             "coverage", "vendor", ".venv", "venv", "__pycache__", ".turbo", ".cache", ".vercel"}
MAX_BYTES = 2_000_000

GENERIC_FAMILIES = {"serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif",
                    "ui-serif", "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "emoji",
                    "math", "fangsong", "inherit", "initial", "unset", "revert", "apple color emoji",
                    "segoe ui emoji", "segoe ui symbol", "noto color emoji"}
DEFAULT_FONTS = {"inter", "roboto", "arial", "helvetica", "helvetica neue", "segoe ui", "open sans",
                 "noto sans", "system-ui", "sans-serif", "verdana", "tahoma", "times new roman", "times"}
OVERUSED_FONTS = {"poppins", "montserrat", "lato", "raleway", "nunito", "space grotesk"}

# Phrases that make copy read as machine-written. Kept to the notorious ones so a hit
# is worth a look; extend it with --banned-words from your own tone-of-voice skill.
CLICHES = [
    "elevate your", "unlock the power", "unlock your", "unleash", "supercharge", "revolutionize",
    "revolutionary", "game-changer", "game changer", "cutting-edge", "next level", "next-level",
    "seamless", "seamlessly", "effortlessly", "empower", "harness the power", "fast-paced world",
    "in today's", "look no further", "say goodbye to", "transform the way", "reimagine", "world-class",
    "state-of-the-art", "best-in-class", "all-in-one", "one-stop", "delve", "tapestry", "embark on",
    "your journey", "meticulously", "at your fingertips", "like never before", "we've got you covered",
    "blazing fast", "lightning-fast", "streamline", "leverage", "robust", "innovative solutions",
]
PLACEHOLDERS = [("lorem ipsum", "error"), ("dolor sit amet", "error"), ("your company", "warn"),
                ("company name", "warn"), ("john doe", "warn"), ("jane doe", "warn"), ("acme", "note"),
                ("feature one", "warn"), ("feature 1", "warn"), ("[your", "warn"), ("todo:", "warn"),
                ("placeholder text", "warn"), ("example.com", "note")]

EMOJI = re.compile("[\U0001F300-\U0001FAFF\U0001F600-\U0001F64F\U0001F680-\U0001F6FF\u2600-\u26FF\u2700-\u27BF\u2B50\u2B06\u2194-\u21FF]")
HEX = re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b")
FUNC_COLOR = re.compile(r"\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*\)", re.I)
DECL = re.compile(r"(?P<prop>--?[A-Za-z0-9_-]+|[A-Za-z-]+)\s*:\s*(?P<val>[^;{}]+)")
SEVERITY_ORDER = {"error": 3, "warn": 2, "note": 1}


@dataclass
class Finding:
    id: str
    severity: str
    message: str
    fix: str
    trick: str
    locations: list[tuple[str, int]] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"id": self.id, "severity": self.severity, "message": self.message, "fix": self.fix,
                "trick": self.trick, "locations": [{"file": f, "line": ln} for f, ln in self.locations]}


@dataclass
class Scan:
    files: list[str] = field(default_factory=list)
    families: dict[str, list[tuple[str, int]]] = field(default_factory=dict)
    raw_colors: dict[str, list[tuple[str, int]]] = field(default_factory=dict)
    token_count: int = 0
    font_sizes: dict[str, list[tuple[str, int]]] = field(default_factory=dict)
    tiny_text: list[tuple[str, int]] = field(default_factory=list)
    gradients: list[tuple[str, int, str]] = field(default_factory=list)  # (file, line, value)
    has_css: bool = False
    outline_removed: list[tuple[str, int]] = field(default_factory=list)
    focus_visible: bool = False
    motion: list[tuple[str, int]] = field(default_factory=list)
    reduced_motion: bool = False
    important: int = 0
    inline_styles: int = 0
    findings: list[Finding] = field(default_factory=list)


# ------------------------------------------------------------------ helpers
def line_at(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _blank(m: re.Match) -> str:
    """Replace a match with spaces, keeping newlines, so offsets and line numbers hold."""
    return re.sub(r"[^\n]", " ", m.group(0))


def strip_code_comments(text: str, ext: str) -> str:
    """Blank out comments (and Astro frontmatter) so markup quoted in docs is not scanned."""
    if ext == ".astro":
        text = re.sub(r"\A---\r?\n.*?\r?\n---", _blank, text, flags=re.S)
    text = re.sub(r"/\*.*?\*/", _blank, text, flags=re.S)
    text = re.sub(r"(?<![:\"'\w\\])//[^\n]*", _blank, text)
    return re.sub(r"<!--.*?-->", _blank, text, flags=re.S)


def norm_color(c: str) -> str:
    c = c.strip().lower()
    if c.startswith("#") and len(c) in (4, 5):
        c = "#" + "".join(ch * 2 for ch in c[1:])
    return re.sub(r"\s+", " ", c)


def hue_of(c: str) -> tuple[float, float] | None:
    """(hue degrees, saturation) for hex or rgb() colors, else None."""
    c = norm_color(c)
    rgb = None
    if c.startswith("#") and len(c) >= 7:
        rgb = tuple(int(c[i:i + 2], 16) / 255 for i in (1, 3, 5))
    else:
        m = re.match(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)", c)
        if m:
            rgb = tuple(min(float(x), 255) / 255 for x in m.groups())
    if not rgb:
        return None
    h, _l, s = colorsys.rgb_to_hls(*rgb)
    return h * 360, s


def families_from(value: str) -> list[str]:
    out = []
    for part in value.split(","):
        name = part.strip().strip("'\"").strip().lower()
        if not name or name.startswith("var(") or name in GENERIC_FAMILIES:
            continue
        out.append(name)
    return out


class TextParser(HTMLParser):
    SKIP = {"script", "style", "svg", "noscript", "template", "code", "pre"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.chunks: list[tuple[str, int]] = []
        self.imgs_no_alt: list[int] = []
        self.has_html = False
        self.html_lang = False
        self.viewport = False
        self.inline_styles = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.SKIP:
            self.depth += 1
        if tag == "html":
            self.has_html = True
            self.html_lang = bool(a.get("lang"))
        if tag == "meta" and (a.get("name") or "").lower() == "viewport":
            self.viewport = True
        if tag == "img" and "alt" not in a:
            self.imgs_no_alt.append(self.getpos()[0])
        if "style" in a:
            self.inline_styles += 1

    def handle_startendtag(self, tag, attrs):
        if tag in self.SKIP:
            return
        self.handle_starttag(tag, attrs)
        if tag in self.SKIP:
            self.depth -= 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if not self.depth and data.strip():
            self.chunks.append((data, self.getpos()[0]))


# ------------------------------------------------------------------ extraction
def css_blocks(path: Path, text: str) -> list[tuple[str, int]]:
    """(css, starting offset) pairs found in a file."""
    ext = path.suffix.lower()
    if ext in {".css", ".scss", ".sass", ".less"}:
        return [(text, 0)]
    blocks = [(m.group(1), m.start(1)) for m in re.finditer(r"<style\b[^>]*>(.*?)</style\s*>", text, re.S | re.I)]
    blocks += [(m.group(1), m.start(1)) for m in re.finditer(r"\bstyle\s*=\s*\"([^\"]*)\"", text)]
    if ext in {".jsx", ".tsx", ".astro", ".vue", ".svelte", ".mdx"}:
        # CSS-in-JS template literals (styled-components, emotion, css``)
        blocks += [(m.group(1), m.start(1)) for m in re.finditer(r"(?:styled\.\w+|styled\([^)]*\)|css|createGlobalStyle|keyframes)`([^`]*)`", text)]
    return blocks


def visible_text(path: Path, text: str) -> tuple[list[tuple[str, int]], TextParser | None]:
    ext = path.suffix.lower()
    if ext in {".html", ".htm"}:
        p = TextParser()
        try:
            p.feed(text)
            p.close()
        except Exception:  # malformed markup: fall back to the regex path below
            p = None
        if p is not None:
            return p.chunks, p
    if ext in {".css", ".scss", ".sass", ".less"}:
        return [], None
    chunks = []
    stripped = re.sub(r"<(script|style)\b.*?</\1\s*>", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S | re.I)
    for m in re.finditer(r">([^<>{}]*[A-Za-z][^<>{}]*)<", stripped):
        chunks.append((m.group(1), line_at(stripped, m.start(1))))
    for m in re.finditer(r"\b(?:alt|title|placeholder|aria-label)\s*=\s*[\"']([^\"']+)[\"']", stripped):
        chunks.append((m.group(1), line_at(stripped, m.start(1))))
    return chunks, None


def scan_css(scan: Scan, rel: str, css: str, base: int, full: str) -> None:
    scan.has_css = True
    css = re.sub(r"/\*.*?\*/", _blank, css, flags=re.S)
    for m in DECL.finditer(css):
        prop, val = m.group("prop").lower(), m.group("val").strip()
        ln = line_at(full, base + m.start())
        if prop.startswith("--"):
            scan.token_count += 1
            if "font" in prop and ("," in val or "'" in val or '"' in val):
                for fam in families_from(val)[:1]:
                    scan.families.setdefault(fam, []).append((rel, ln))
            continue
        if prop == "font-family":
            fams = families_from(val)
            if fams:
                scan.families.setdefault(fams[0], []).append((rel, ln))
        if prop == "font-size" and "var(" not in val and "clamp(" not in val and "calc(" not in val:
            size = val.split("!")[0].strip().lower()
            scan.font_sizes.setdefault(size, []).append((rel, ln))
            px = re.match(r"([\d.]+)px$", size)
            rem = re.match(r"([\d.]+)r?em$", size)
            if (px and float(px.group(1)) < 12) or (rem and float(rem.group(1)) < 0.75):
                scan.tiny_text.append((rel, ln))
        if "gradient(" in val:
            scan.gradients.append((rel, ln, val))
        for c in HEX.findall(val) + FUNC_COLOR.findall(val):
            if not c.lower().startswith("color(") or "srgb" in c.lower():
                scan.raw_colors.setdefault(norm_color(c), []).append((rel, ln))
        if prop in {"outline", "outline-style", "outline-width"} and re.match(r"(none|0)(\s|$|!)", val):
            scan.outline_removed.append((rel, ln))
        # Keyframe animation is what reduced-motion users need a way out of; a short
        # hover transition is not, so transitions are deliberately not counted.
        if prop in {"animation", "animation-name"} and val not in {"none", "0"}:
            scan.motion.append((rel, ln))
        if "!important" in val:
            scan.important += 1
    if ":focus-visible" in css:
        scan.focus_visible = True
    if "prefers-reduced-motion" in css:
        scan.reduced_motion = True
    if "@keyframes" in css:
        scan.motion.append((rel, line_at(full, base + css.find("@keyframes"))))


def scan_file(scan: Scan, path: Path, rel: str, banned: list[str]) -> None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    scan.files.append(rel)
    if path.suffix.lower() in {".jsx", ".tsx", ".vue", ".svelte", ".astro", ".mdx"}:
        text = strip_code_comments(text, path.suffix.lower())

    # Fonts loaded by URL or import
    for m in re.finditer(r"fonts\.googleapis\.com/css2?\?([^\"'\s)>]+)", text):
        for fam in re.findall(r"family=([^:&]+)", m.group(1)):
            scan.families.setdefault(fam.replace("+", " ").lower(), []).append((rel, line_at(text, m.start())))
    for m in re.finditer(r"api\.fontshare\.com/v2/css\?([^\"'\s)>]+)", text):
        for fam in re.findall(r"f\[\]=([a-z0-9-]+)", m.group(1)):
            scan.families.setdefault(fam.replace("-", " "), []).append((rel, line_at(text, m.start())))
    for m in re.finditer(r"import\s*\{([^}]+)\}\s*from\s*['\"]next/font/google['\"]", text):
        for fam in m.group(1).split(","):
            name = fam.strip().split(" as ")[0].replace("_", " ").strip().lower()
            if name:
                scan.families.setdefault(name, []).append((rel, line_at(text, m.start())))

    for css, base in css_blocks(path, text):
        scan_css(scan, rel, css, base, text)

    # Tailwind classes
    for m in re.finditer(r"\bclass(?:Name)?\s*=\s*[{`\"']+([^\"'`}]+)", text):
        classes = m.group(1)
        ln = line_at(text, m.start())
        for c in re.findall(r"(?:bg|text|border|from|via|to|fill|stroke)-\[(#[0-9a-fA-F]{3,8})\]", classes):
            scan.raw_colors.setdefault(norm_color(c), []).append((rel, ln))
        for s in re.findall(r"\btext-\[(\d+(?:\.\d+)?(?:px|rem|em))\]", classes):
            scan.font_sizes.setdefault(s, []).append((rel, ln))
        if re.search(r"\bfrom-(purple|violet|indigo|fuchsia)-\d+", classes) and re.search(r"\bto-(purple|violet|indigo|fuchsia|pink|blue)-\d+", classes):
            scan.gradients.append((rel, ln, "tailwind purple gradient"))
        if re.search(r"(?<![\w-])animate-(?!none)", classes):
            scan.motion.append((rel, ln))
        if "motion-reduce:" in classes or "motion-safe:" in classes:
            scan.reduced_motion = True
    if re.search(r"\b(gsap|framer-motion|motion/react|animejs|lottie)\b", text):
        scan.motion.append((rel, 1))
    if re.search(r"prefers-reduced-motion|useReducedMotion|matchMedia\([^)]*reduce", text):
        scan.reduced_motion = True

    chunks, parser = visible_text(path, text)
    copy_lower = [(c.lower(), ln) for c, ln in chunks]

    # Copy tells
    hits: dict[str, list[tuple[str, int]]] = {}
    for phrase in CLICHES:
        pat = re.compile(r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])")
        for chunk, ln in copy_lower:
            if pat.search(chunk):
                hits.setdefault(phrase, []).append((rel, ln))
    if hits:
        total = sum(len(v) for v in hits.values())
        top = sorted(hits, key=lambda k: -len(hits[k]))[:6]
        scan.findings.append(Finding(
            "copy/cliche", "warn" if total >= 3 else "note",
            f"{total} AI-sounding phrase(s): " + ", ".join(f'"{p}" x{len(hits[p])}' for p in top),
            "Rewrite in the audience's words: study how the top players in the niche talk (Easy #6), "
            "then keep a banned-words list in a tone-of-voice skill (Intermediate #12).",
            "6, 12", [loc for p in top for loc in hits[p]][:8]))
    if banned:
        bhits = []
        for word in banned:
            pat = re.compile(r"(?<![a-z])" + re.escape(word.lower()) + r"(?![a-z])")
            bhits += [(word, rel, ln) for chunk, ln in copy_lower if pat.search(chunk)]
        if bhits:
            words = sorted({w for w, _, _ in bhits})
            scan.findings.append(Finding(
                "copy/banned", "warn", f"{len(bhits)} use(s) of your banned words: " + ", ".join(words[:10]),
                "Replace them using your tone-of-voice skill's preferred alternatives.", "12",
                [(f, ln) for _, f, ln in bhits][:8]))
    by_sev: dict[str, list[tuple[str, list[tuple[str, int]]]]] = {}
    for phrase, sev in PLACEHOLDERS:
        locs = [(rel, ln) for chunk, ln in copy_lower if phrase in chunk]
        if locs:
            by_sev.setdefault(sev, []).append((phrase, locs))
    for sev, items in by_sev.items():
        scan.findings.append(Finding(
            "copy/placeholder", sev, "Placeholder text: " + ", ".join(f'"{p}" x{len(l)}' for p, l in items),
            "Replace with real, specific copy before anyone sees it.", "6",
            [loc for _, l in items for loc in l][:6]))

    # Emoji as icons
    emoji_hits = [(e, ln) for chunk, ln in chunks for e in EMOJI.findall(chunk)]
    if len(emoji_hits) >= 3:
        distinct = []
        for e, _ in emoji_hits:
            if e not in distinct:
                distinct.append(e)
        scan.findings.append(Finding(
            "icons/emoji", "warn", f"{len(emoji_hits)} emoji used in UI text: " + " ".join(distinct[:8]),
            "Use one icon set in one style (Intermediate #16) or ask for SVG icons (#17); keep emoji for chat, not UI.",
            "16, 17", [(rel, ln) for _, ln in emoji_hits][:5]))

    # Images without alt text
    if parser is not None:
        missing = parser.imgs_no_alt
        scan.inline_styles += parser.inline_styles
        if parser.has_html and not parser.viewport:
            scan.findings.append(Finding("a11y/viewport", "warn", "No <meta name=viewport> - phones will render the desktop layout",
                                         'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', "11", [(rel, 1)]))
        if parser.has_html and not parser.html_lang:
            scan.findings.append(Finding("a11y/lang", "note", "<html> has no lang attribute",
                                         'Add lang="en" (or the page language) so screen readers pronounce it right.', "11", [(rel, 1)]))
    else:
        missing = [line_at(text, m.start()) for m in re.finditer(r"<(?:img|Image)\b(?:(?!>)[\s\S])*?>", text)
                   if not re.search(r"\balt\s*=", m.group(0))]
    if missing:
        scan.findings.append(Finding("a11y/img-alt", "error", f"{len(missing)} image(s) without alt text",
                                     'Describe what the image shows, or alt="" when it is purely decorative.', "11",
                                     [(rel, ln) for ln in missing][:8]))


def aggregate(scan: Scan) -> None:
    f = scan.findings
    fams = scan.families
    if scan.has_css and not fams:
        f.append(Finding("font/none", "warn", "No font family is chosen anywhere - the browser default is doing the talking",
                         "Pick a typeface that fits the brand (Fontshare, or a Fontjoy pairing) and set it in your tokens.", "5"))
    elif fams:
        names = sorted(fams)
        if all(n in DEFAULT_FONTS for n in names):
            f.append(Finding("font/default", "warn", "Only default fonts in use: " + ", ".join(names),
                             "Default type is the fastest tell of a generated page. Choose a brand-fit display + body pair (Easy #5).",
                             "5", [loc for n in names for loc in fams[n]][:4]))
        over = [n for n in names if n in OVERUSED_FONTS]
        if over:
            f.append(Finding("font/overused", "note", "Very common choice(s): " + ", ".join(over),
                             "Fine when deliberate; otherwise a less expected face gives the brand a voice.", "5"))
        if len(names) > 3:
            f.append(Finding("font/too-many", "warn", f"{len(names)} font families: " + ", ".join(names[:8]),
                             "Two families (display + body), three at most. Fewer families read as intentional.", "5"))

    raw = scan.raw_colors
    if len(raw) > 12:
        top = sorted(raw, key=lambda c: -len(raw[c]))[:8]
        f.append(Finding("color/sprawl", "warn", f"{len(raw)} different raw colors outside tokens (top: {', '.join(top)})",
                         "Put the palette in design tokens (:root custom properties or DESIGN.md) and reference those.",
                         "1", [loc for c in top for loc in raw[c][:1]]))
    elif scan.token_count and len(raw) > 5:
        f.append(Finding("color/bypass", "note", f"{len(raw)} raw colors bypass your tokens",
                         "Replace literals with the token that means the same thing.", "1"))

    stock = []
    for rel, ln, val in scan.gradients:
        if val == "tailwind purple gradient" or re.search(r"#667eea|#764ba2", val, re.I):
            stock.append((rel, ln))
            continue
        hues = [hue_of(c) for c in HEX.findall(val) + FUNC_COLOR.findall(val)]
        purple = [h for h in hues if h and 230 <= h[0] <= 300 and h[1] > 0.3]
        if len(purple) >= 2:
            stock.append((rel, ln))
    if stock:
        f.append(Finding("color/stock-gradient", "warn", f"{len(stock)} purple/indigo gradient(s) - the stock AI look",
                         "Take color and gradients from a real design system you like (Easy #2, #7) instead of the default.",
                         "2, 7", stock[:4]))

    sizes = scan.font_sizes
    if len(sizes) > 10:
        f.append(Finding("type/scale-sprawl", "warn", f"{len(sizes)} different font sizes",
                         "Use a type scale of 6-8 steps in your tokens so hierarchy is deliberate.", "1",
                         [loc for s in list(sizes)[:4] for loc in sizes[s][:1]]))
    if scan.tiny_text:
        f.append(Finding("type/tiny", "note", f"{len(scan.tiny_text)} font size(s) under 12px",
                         "Small text strains reading; Apple's HIG floor is 11pt and its default body is 17pt (Advanced #20).",
                         "20", scan.tiny_text[:4]))

    if scan.outline_removed and not scan.focus_visible:
        f.append(Finding("a11y/focus", "warn", "Focus outlines are removed and no :focus-visible style replaces them",
                         "Keyboard users lose their place. Add a visible :focus-visible ring.", "11", scan.outline_removed[:4]))
    if scan.motion and not scan.reduced_motion:
        f.append(Finding("motion/reduced", "warn", "Animation without a prefers-reduced-motion fallback",
                         "Wrap motion in @media (prefers-reduced-motion: no-preference) or gsap.matchMedia().", "21",
                         scan.motion[:3]))
    if scan.has_css and scan.token_count == 0:
        f.append(Finding("tokens/none", "note", "No design tokens (CSS custom properties) found",
                         "Tokens keep the design consistent and make it tweakable (Easy #1, Advanced #23).", "1, 23"))
    if scan.important > 15:
        f.append(Finding("css/important", "note", f"{scan.important} !important declarations",
                         "Usually a sign of fighting the cascade; fix the selector order instead.", "1"))
    if scan.inline_styles > 20:
        f.append(Finding("css/inline-styles", "note", f"{scan.inline_styles} inline style attributes",
                         "Move repeated inline styles into classes or tokens.", "1"))


def collect(paths: list[Path]) -> list[tuple[Path, str]]:
    out = []
    for p in paths:
        if p.is_file():
            out.append((p, p.name))
            continue
        for dirpath, dirnames, filenames in os.walk(p):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                fp = Path(dirpath) / name
                if fp.suffix.lower() not in EXTS or ".min." in name:
                    continue
                try:
                    if fp.stat().st_size > MAX_BYTES:
                        continue
                except OSError:
                    continue
                out.append((fp, str(fp.relative_to(p)).replace("\\", "/")))
    return out


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure") and (sys.stdout.encoding or "").lower().replace("-", "") != "utf8":
        sys.stdout.reconfigure(errors="backslashreplace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--banned-words", type=Path)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--fail-on", choices=["error", "warn", "never"], default="error")
    args = ap.parse_args(argv)

    missing = [str(p) for p in args.paths if not p.exists()]
    if missing:
        print("error: not found: " + ", ".join(missing), file=sys.stderr)
        return 2
    banned = []
    if args.banned_words:
        try:
            banned = [ln.strip() for ln in args.banned_words.read_text(encoding="utf-8").splitlines()
                      if ln.strip() and not ln.strip().startswith("#")]
        except OSError as exc:
            print(f"error: cannot read {args.banned_words}: {exc}", file=sys.stderr)
            return 2

    scan = Scan()
    files = collect(args.paths)
    for fp, rel in files:
        scan_file(scan, fp, rel, banned)
    aggregate(scan)
    scan.findings.sort(key=lambda x: (-SEVERITY_ORDER[x.severity], x.id))
    counts = {s: sum(1 for x in scan.findings if x.severity == s) for s in ("error", "warn", "note")}

    if args.json:
        print(json.dumps({"files": scan.files, "summary": counts,
                          "findings": [x.as_dict() for x in scan.findings]}, indent=2))
    else:
        print(f"slop_check: {len(scan.files)} file(s) scanned")
        if not scan.findings:
            print("  nothing flagged. Still look at it rendered, at phone width, in both themes.")
        for x in scan.findings:
            where = ", ".join(f"{f}:{ln}" for f, ln in x.locations[:3]) or "(whole design)"
            print(f"  {x.severity.upper():5}  {x.id:21} {where}")
            print(f"         {x.message}")
            print(f"         fix: {x.fix}  [trick {x.trick}]")
        print(f"summary: {counts['error']} error(s), {counts['warn']} warning(s), {counts['note']} note(s)")

    threshold = {"error": 3, "warn": 2, "never": 99}[args.fail_on]
    return 1 if any(SEVERITY_ORDER[x.severity] >= threshold for x in scan.findings) else 0


if __name__ == "__main__":
    sys.exit(main())
