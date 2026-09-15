import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LEGAL_SOURCES = [
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'PRIVACY.md',
  'TERMS.md',
] as const;

export type LegalSource = (typeof LEGAL_SOURCES)[number];

/**
 * Astro builds @vyotiq/landing with cwd = landing/.
 * Bundled import.meta.url is unreliable for locating the monorepo root,
 * so we read the bake-legal copies under public/legal/ (byte-identical to repo
 * root files; verify-dist re-checks sha256 against the repo).
 */
export function getLandingRoot(): string {
  return process.env.LANDING_ROOT ? path.resolve(process.env.LANDING_ROOT) : process.cwd();
}

export function bakedLegalPath(source: LegalSource): string {
  return path.join(getLandingRoot(), 'public', 'legal', source);
}

export function repoLegalPath(source: LegalSource): string {
  return path.join(getLandingRoot(), '..', source);
}

export function readRepoLegal(source: LegalSource): string {
  return legalFileMeta(source).text;
}

export function legalFileMeta(source: LegalSource) {
  const baked = bakedLegalPath(source);
  if (!fs.existsSync(baked)) {
    throw new Error(
      `Missing baked legal file at ${baked}. Run: node scripts/bake-legal.mjs`,
    );
  }
  const buf = fs.readFileSync(baked);
  const text = buf.toString('utf8');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  // Cross-check against the monorepo source of truth when available
  const repoPath = repoLegalPath(source);
  if (fs.existsSync(repoPath)) {
    const repoSha = crypto.createHash('sha256').update(fs.readFileSync(repoPath)).digest('hex');
    if (repoSha !== sha256) {
      throw new Error(
        `Baked ${source} sha256 ${sha256} does not match repo ${repoPath} (${repoSha}). Re-run bake-legal.`,
      );
    }
  }

  return { bytes: buf.length, sha256, text, bakedPath: baked, repoPath };
}

/**
 * Minimal Markdown → HTML for SECURITY.md / CODE_OF_CONDUCT.md / NOTICE.
 * Only covers constructs present in those files. Does not invent content.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let paragraph: string[] = [];

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
  };
  const flushPara = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const inline = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="av-code">$1</code>')
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a class="av-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd().trim();

    if (!trimmed) {
      flushPara();
      closeLists();
      continue;
    }

    if (/^\|?[\s:-]+\|/.test(trimmed) && inTable) continue;

    if (trimmed.startsWith('|')) {
      flushPara();
      closeLists();
      const cells = trimmed
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      const next = lines[i + 1]?.trim() ?? '';
      const isHeaderSep = /^\|?[\s:-]+\|/.test(next);
      if (!inTable) {
        out.push('<table class="av-legal-table"><thead><tr>');
        cells.forEach((c) => out.push(`<th>${inline(c)}</th>`));
        out.push('</tr></thead><tbody>');
        inTable = true;
        if (isHeaderSep) i++;
        continue;
      }
      out.push('<tr>');
      cells.forEach((c) => out.push(`<td>${inline(c)}</td>`));
      out.push('</tr>');
      continue;
    } else {
      closeTable();
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      closeLists();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${inline(trimmed.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      flushPara();
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${inline(trimmed.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    closeLists();
    paragraph.push(trimmed);
  }

  flushPara();
  closeLists();
  closeTable();
  return out.join('\n');
}
