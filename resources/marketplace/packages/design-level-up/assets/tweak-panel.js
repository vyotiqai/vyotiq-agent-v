/*!
 * tweak-panel.js - live design-token controls for any HTML page.
 * Part of the design-level-up skill (Advanced, trick 23: your own tweak panel).
 *
 * What it does
 *   - Finds the CSS custom properties declared on :root / html (the design tokens).
 *   - Shows one control per token: a color picker, a slider for lengths, numbers
 *     and durations, a text field for font stacks and everything else.
 *   - Hide mode: click any element on the page to hide it; the selector is kept.
 *   - Exports what changed as CSS or JSON so the values can be baked back into the
 *     source (scripts/tweak.py bake tweaks.json styles.css).
 *
 * Load it (this file never contains a closing script tag, so it is safe to inline verbatim)
 *   python scripts/tweak.py inject page.html     inlines it between marker comments
 *   a script tag with src="tweak-panel.js" and defer, like any other script
 *   or paste the whole file into the DevTools console of any page
 *
 * Options - attributes on the script tag, all optional
 *   data-include="--color-,--space-"   only show tokens that start with these
 *   data-exclude="--tw-"               skip tokens that start with these (default --tw-)
 *   data-collapsed                     start collapsed
 *
 * Agent API - window.tweaks
 *   tweaks.export()       { page, scheme, vars: {name: {from, to}}, hidden: [{selector, text}] }
 *   tweaks.css()          the same changes as a CSS snippet
 *   tweaks.list()         every detected token with its kind and current value
 *   tweaks.set(name, v)   change a token        tweaks.reset()   undo everything
 *   tweaks.rescan()       re-read the stylesheets (after CSS is injected late)
 */
(() => {
  'use strict';
  if (window.tweaks && window.tweaks.__panel) return;

  const script = document.currentScript;
  const ds = (script && script.dataset) || {};
  const splitList = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const CONFIG = {
    include: splitList(ds.include),
    exclude: splitList(ds.exclude || '--tw-'),
    collapsed: 'collapsed' in ds,
  };

  // Tailwind v4 and similar kits declare a whole default palette on :root. Those
  // are not the page's own tokens, so they stay out unless included explicitly.
  const PALETTE_NOISE =
    /^--color-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;
  const ROOT_SELECTOR = /(^|,)\s*(:root|html)\b/i;
  const LENGTHY_NAME = /radius|space|spacing|gap|size|width|height|pad|margin|inset|offset|blur|gutter|indent|stroke/i;
  const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
  const RE_LENGTH = new RegExp('^(' + NUM + ')(px|rem|em|%|vh|vw|vmin|vmax|svh|dvh|ch|ex|pt)$');
  const RE_TIME = new RegExp('^(' + NUM + ')(ms|s)$');
  const RE_NUMBER = new RegExp('^(' + NUM + ')$');
  const GROUP_ORDER = ['color', 'font', 'text', 'space', 'radius', 'shadow', 'motion'];
  const GROUP_ALIAS = {
    colour: 'color', colors: 'color', clr: 'color', bg: 'color', fg: 'color', surface: 'color',
    spacing: 'space', gap: 'space', sp: 'space', rounded: 'radius', r: 'radius', ff: 'font',
    family: 'font', fs: 'text', type: 'text', typography: 'text', leading: 'text',
    duration: 'motion', dur: 'motion', ease: 'motion', easing: 'motion', elevation: 'shadow',
  };

  const root = document.documentElement;
  const STORE_KEY = 'tweaks:' + location.pathname;
  const state = { tokens: [], changed: new Map(), hidden: [], hideMode: false, collapsed: CONFIG.collapsed };
  // Groups the user opened or closed by hand; everything else follows the default.
  const userOpen = new Set();
  const userClosed = new Set();

  // ---------- small helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => String(+(+n).toFixed(4));
  const computed = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const tokenByName = (name) => state.tokens.find((t) => t.name === name);

  let ctx2d = null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    ctx2d = c.getContext('2d', { willReadFrequently: true });
  } catch { /* no canvas: color inputs fall back to text */ }

  function toRGBA(value) {
    if (!ctx2d) return null;
    ctx2d.clearRect(0, 0, 1, 1);
    ctx2d.fillStyle = '#000';
    ctx2d.fillStyle = value; // an invalid value leaves the #000 in place
    ctx2d.fillRect(0, 0, 1, 1);
    const d = ctx2d.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: +(d[3] / 255).toFixed(3) };
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const toHex = (c) => '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);

  function isColor(value) {
    if (!value || /^(inherit|initial|unset|revert|revert-layer|currentcolor|none)$/i.test(value)) return false;
    return !!(window.CSS && CSS.supports && CSS.supports('color', value));
  }

  function kindOf(name, value) {
    if (value === '0' && LENGTHY_NAME.test(name)) return 'length';
    if (RE_LENGTH.test(value)) return 'length';
    if (RE_TIME.test(value)) return 'time';
    if (RE_NUMBER.test(value)) return 'number';
    if (isColor(value)) return 'color';
    if (/font|family|typeface/i.test(name)) return 'font';
    return 'text';
  }

  function rangeFor(kind, value) {
    const step2 = (x, step) => +(Math.ceil(x / step) * step).toFixed(4);
    if (kind === 'length') {
      const m = value.match(RE_LENGTH) || [null, '0', 'px'];
      const v = parseFloat(m[1]);
      const unit = m[2];
      const table = { px: [1, 64], rem: [0.025, 4], em: [0.025, 4], '%': [1, 100], pt: [1, 48], ch: [1, 80] };
      const [step, floor] = table[unit] || [0.5, 50];
      const max = Math.max(floor, step2(Math.abs(v) * 4, step));
      return { unit, min: v < 0 ? -max : 0, max, step, value: v };
    }
    if (kind === 'time') {
      const m = value.match(RE_TIME);
      const v = parseFloat(m[1]);
      return m[2] === 'ms'
        ? { unit: 'ms', min: 0, max: Math.max(1000, v * 4), step: 10, value: v }
        : { unit: 's', min: 0, max: Math.max(2, v * 4), step: 0.05, value: v };
    }
    const v = parseFloat(value);
    if (v >= 100 && v <= 900 && v % 100 === 0) return { unit: '', min: 100, max: 900, step: 100, value: v };
    if (Math.abs(v) <= 4) return { unit: '', min: v < 0 ? -4 : 0, max: Math.max(3, +(Math.abs(v) * 3).toFixed(2)), step: 0.01, value: v };
    return { unit: '', min: v < 0 ? -Math.abs(v) * 4 : 0, max: Math.max(10, Math.abs(v) * 4), step: 1, value: v };
  }

  function groupsFor(names) {
    // Namespaced token sets (--acme-color-bg, --acme-space-4) would all land in one
    // group, so when one leading segment dominates, group by the second one instead.
    const first = names.map((n) => (n.match(/^--([a-z0-9]+)/i) || [])[1] || 'other');
    const counts = {};
    first.forEach((f) => { counts[f] = (counts[f] || 0) + 1; });
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const namespaced = names.length >= 8 && counts[top] / names.length > 0.8;
    return names.map((n, i) => {
      let seg = first[i];
      if (namespaced && seg === top) seg = (n.match(/^--[a-z0-9]+-([a-z0-9]+)/i) || [])[1] || seg;
      seg = seg.toLowerCase();
      return GROUP_ALIAS[seg] || seg;
    });
  }

  // ---------- token discovery ----------
  function collectNames() {
    const names = new Set();
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.type === 1 /* STYLE_RULE */) {
          if (ROOT_SELECTOR.test(rule.selectorText || '')) {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith('--')) names.add(prop);
            }
          }
          if (rule.cssRules && rule.cssRules.length) visit(rule.cssRules); // CSS nesting
        } else if (rule.cssRules) {
          visit(rule.cssRules); // @media, @supports, @layer, @container
        }
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.closest && sheet.ownerNode.closest('[data-tweak-panel]')) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet: unreadable
      if (rules) visit(rules);
    }
    for (let i = 0; i < root.style.length; i++) {
      const prop = root.style[i];
      if (prop.startsWith('--')) names.add(prop);
    }
    return [...names];
  }

  function allowed(name) {
    if (CONFIG.include.length && !CONFIG.include.some((p) => name.startsWith(p))) return false;
    if (CONFIG.exclude.some((p) => name.startsWith(p))) return false;
    if (!CONFIG.include.length && PALETTE_NOISE.test(name)) return false;
    return true;
  }

  function scan() {
    const names = collectNames().filter(allowed);
    const live = names.map((name) => {
      const inline = root.style.getPropertyValue(name).trim();
      const mine = state.changed.has(name);
      // A value we set ourselves is not the original: read the stylesheet value.
      if (mine) root.style.removeProperty(name);
      const original = computed(name);
      if (mine) root.style.setProperty(name, state.changed.get(name));
      const prev = tokenByName(name);
      return { name, original: prev ? prev.original : original, inline: prev ? prev.inline : (mine ? '' : inline) };
    }).filter((t) => t.original !== '');
    const groups = groupsFor(live.map((t) => t.name));
    state.tokens = live.map((t, i) => ({ ...t, kind: kindOf(t.name, t.original), group: groups[i] }));
    state.tokens.sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.group), gb = GROUP_ORDER.indexOf(b.group);
      const oa = ga === -1 ? 99 : ga, ob = gb === -1 ? 99 : gb;
      return oa - ob || a.group.localeCompare(b.group);
    });
    if (ui) renderTokens();
    return state.tokens.length;
  }

  // ---------- applying changes ----------
  function setToken(name, value, opts) {
    const o = opts || {};
    const tok = tokenByName(name);
    const v = String(value).trim();
    if (tok && v === tok.original) {
      if (tok.inline) root.style.setProperty(name, tok.inline);
      else root.style.removeProperty(name);
      state.changed.delete(name);
    } else {
      root.style.setProperty(name, v);
      state.changed.set(name, v);
    }
    if (o.persist !== false) save();
    if (ui) { updateCount(); if (o.sync !== false) syncRow(name); else markRow(name); }
  }

  function resetAll() {
    for (const name of [...state.changed.keys()]) setToken(name, (tokenByName(name) || {}).original || '', { persist: false });
    for (const h of [...state.hidden]) unhide(h, false);
    state.hidden = [];
    try { localStorage.removeItem(STORE_KEY); } catch { /* storage blocked */ }
    if (ui) { renderTokens(); renderHidden(); updateCount(); }
  }

  // ---------- hide mode ----------
  function cssPath(el) {
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== root) {
      if (node.id && unique('#' + CSS.escape(node.id))) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function snippet(el) {
    const text = el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent || '';
    return ('<' + el.localName + '> ' + text.replace(/\s+/g, ' ').trim()).slice(0, 72);
  }

  function hide(el, persist) {
    const prev = { value: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') };
    el.style.setProperty('display', 'none', 'important');
    state.hidden.push({ selector: cssPath(el), text: snippet(el), el, prev });
    if (persist !== false) save();
    if (ui) { renderHidden(); updateCount(); }
  }

  function unhide(h, persist) {
    if (h.el) {
      if (h.prev && h.prev.value) h.el.style.setProperty('display', h.prev.value, h.prev.priority);
      else h.el.style.removeProperty('display');
    }
    state.hidden = state.hidden.filter((x) => x !== h);
    if (persist !== false) save();
    if (ui) { renderHidden(); updateCount(); }
  }

  // ---------- persistence (per page, per browser; optional) ----------
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        vars: Object.fromEntries(state.changed),
        hidden: state.hidden.map((h) => ({ selector: h.selector, text: h.text })),
      }));
    } catch { /* storage blocked (private window, file:// policy): tweaks still work for this visit */ }
  }

  function restore() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
    if (!saved) return;
    for (const [name, value] of Object.entries(saved.vars || {})) {
      if (tokenByName(name)) setToken(name, value, { persist: false });
    }
    for (const h of saved.hidden || []) {
      let el;
      try { el = document.querySelector(h.selector); } catch { el = null; }
      // Only re-hide when the element still looks the same: after the source is
      // edited, nth-of-type selectors can point at a different element.
      if (el && snippet(el) === h.text) hide(el, false);
    }
  }

  // ---------- export ----------
  function scheme() {
    const marks = [root.getAttribute('data-theme'), root.getAttribute('data-color-scheme'), root.getAttribute('data-mode'), root.className]
      .filter(Boolean).join(' ');
    if (/\bdark\b/i.test(marks)) return 'dark';
    if (/\blight\b/i.test(marks)) return 'light';
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function exportState() {
    const vars = {};
    for (const [name, to] of state.changed) vars[name] = { from: (tokenByName(name) || {}).original || null, to };
    return {
      tool: 'design-level-up/tweak-panel',
      version: 1,
      page: location.pathname,
      url: location.href,
      scheme: scheme(),
      vars,
      hidden: state.hidden.map((h) => ({ selector: h.selector, text: h.text })),
      exportedAt: new Date().toISOString(),
    };
  }

  function toCSS() {
    const e = exportState();
    const lines = ['/* tweak-panel changes for ' + e.page + ' (' + e.scheme + ' scheme) */'];
    const names = Object.keys(e.vars);
    if (names.length) {
      lines.push(':root {');
      names.forEach((n) => lines.push('  ' + n + ': ' + e.vars[n].to + '; /* was ' + e.vars[n].from + ' */'));
      lines.push('}');
    }
    if (e.hidden.length) {
      lines.push('', '/* hidden while reviewing: delete these elements from the source */');
      e.hidden.forEach((h) => lines.push(h.selector + ' { display: none !important; } /* ' + h.text.replace(/\*\//g, '') + ' */'));
    }
    if (!names.length && !e.hidden.length) lines.push('/* nothing changed yet */');
    return lines.join('\n');
  }

  // ---------- UI ----------
  let ui = null;

  const STYLE = `
    :host { all: initial; --bg:#ffffff; --fg:#1d1d20; --muted:#6a6a72; --line:#e2e2e6; --soft:#f3f3f5; --accent:#2f5bd8; --on-accent:#ffffff; --warn:#b4540a; }
    @media (prefers-color-scheme: dark) { :host { --bg:#1b1b1f; --fg:#f1f1f3; --muted:#a2a2ab; --line:#35353c; --soft:#26262c; --accent:#8aa7ff; --on-accent:#10131c; --warn:#f0a35e; } }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .panel, .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
    .panel { width: 320px; max-height: min(72vh, 640px); display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.2); overflow: hidden; }
    .fab { padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); box-shadow: 0 6px 18px rgba(0,0,0,.18); }
    header { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--line); }
    header strong { font-size: 13px; flex: none; }
    .count { flex: 1; min-width: 0; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn { border: 1px solid var(--line); background: var(--soft); border-radius: 6px; padding: 3px 8px; }
    .btn:hover { border-color: var(--muted); }
    .btn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .search { margin: 8px 12px 4px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
    .groups { overflow: auto; padding: 0 4px 6px; flex: 1; }
    details { border-bottom: 1px solid var(--line); }
    summary { cursor: pointer; padding: 7px 8px; font-weight: 600; text-transform: capitalize; list-style-position: inside; }
    summary .n { color: var(--muted); font-weight: 400; }
    .row { display: grid; grid-template-columns: 104px 1fr 22px; align-items: center; gap: 6px; padding: 3px 8px; }
    .row label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
    .row.changed label { color: var(--fg); font-weight: 600; }
    .row.changed label::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--accent); vertical-align: 1px; }
    .ctl { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .ctl input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); }
    .ctl input[type=number] { width: 58px; padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
    .ctl input[type=text] { flex: 1; min-width: 0; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
    .ctl input[type=color] { width: 28px; height: 22px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: none; }
    .unit { color: var(--muted); min-width: 18px; }
    .reset { border: 0; background: none; color: var(--muted); padding: 0; visibility: hidden; }
    .row.changed .reset { visibility: visible; }
    .hidden-list { border-top: 1px solid var(--line); padding: 6px 12px; max-height: 120px; overflow: auto; }
    .hidden-list:empty { display: none; }
    .hidden-list .h { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
    .hidden-list .h span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    footer { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--line); }
    .empty { padding: 10px 8px; color: var(--muted); }
    .toast { position: absolute; left: 12px; right: 12px; bottom: 52px; padding: 6px 10px; border-radius: 6px; background: var(--fg); color: var(--bg); opacity: 0; transition: opacity .2s; pointer-events: none; }
    .toast.on { opacity: 1; }
    .hl { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid var(--warn); background: rgba(240,120,40,.12); border-radius: 2px; }
    .modal { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.35); z-index: 2147483647; }
    .modal .box { width: min(560px, 92vw); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; color: var(--fg); }
    .modal textarea { width: 100%; height: 260px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    [hidden] { display: none !important; }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.setAttribute('data-tweak-panel-host', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + STYLE + '</style>' +
      '<div class="hl" hidden></div>' +
      '<button class="fab" type="button" hidden>Tweaks</button>' +
      '<section class="panel" role="dialog" aria-label="Design tweaks">' +
      '  <header><strong>Tweaks</strong><span class="count"></span>' +
      '    <button class="btn" type="button" data-act="rescan" title="Re-read the stylesheets">Rescan</button>' +
      '    <button class="btn" type="button" data-act="hide" aria-pressed="false" title="Click elements on the page to hide them (Esc to stop)">Hide</button>' +
      '    <button class="btn" type="button" data-act="collapse" aria-label="Collapse panel" title="Collapse (Alt+Shift+T)">&#8211;</button>' +
      '  </header>' +
      '  <input class="search" type="search" placeholder="Filter tokens" aria-label="Filter tokens">' +
      '  <div class="groups"></div>' +
      '  <div class="hidden-list" aria-label="Hidden elements"></div>' +
      '  <footer>' +
      '    <button class="btn" type="button" data-act="css">Copy CSS</button>' +
      '    <button class="btn" type="button" data-act="json">Copy JSON</button>' +
      '    <button class="btn" type="button" data-act="save">Save JSON</button>' +
      '    <button class="btn" type="button" data-act="reset">Reset</button>' +
      '  </footer>' +
      '  <div class="toast" role="status" aria-live="polite"></div>' +
      '</section>';
    (document.body || root).appendChild(host);
    const $ = (sel) => shadow.querySelector(sel);
    ui = { host, shadow, panel: $('.panel'), fab: $('.fab'), groups: $('.groups'), search: $('.search'),
      hiddenList: $('.hidden-list'), count: $('.count'), toast: $('.toast'), hl: $('.hl'), hideBtn: $('[data-act=hide]') };

    ui.search.addEventListener('input', renderTokens);
    ui.fab.addEventListener('click', () => setCollapsed(false));
    shadow.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'collapse') setCollapsed(true);
      else if (act === 'hide') setHideMode(!state.hideMode);
      else if (act === 'rescan') { const n = scan(); toast(n + ' tokens found'); }
      else if (act === 'css') copy(toCSS(), 'CSS');
      else if (act === 'json') copy(JSON.stringify(exportState(), null, 2), 'JSON');
      else if (act === 'save') download();
      else if (act === 'reset') resetAll();
    });

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'T' || e.key === 't')) { e.preventDefault(); setCollapsed(!state.collapsed); }
      else if (e.key === 'Escape' && state.hideMode) { e.preventDefault(); setHideMode(false); }
    }, true);
    const inPanel = (e) => e.composedPath().includes(host);
    const block = (e) => { if (state.hideMode && !inPanel(e)) { e.preventDefault(); e.stopPropagation(); } };
    ['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach((t) => document.addEventListener(t, block, true));
    document.addEventListener('mousemove', (e) => {
      if (!state.hideMode) return;
      const el = !inPanel(e) && e.target instanceof Element && e.target !== root && e.target !== document.body ? e.target : null;
      if (!el) { ui.hl.hidden = true; return; }
      const r = el.getBoundingClientRect();
      Object.assign(ui.hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      ui.hl.hidden = false;
    }, true);
    document.addEventListener('click', (e) => {
      if (!state.hideMode || inPanel(e)) return;
      e.preventDefault(); e.stopPropagation();
      const el = e.target;
      if (el instanceof Element && el !== root && el !== document.body) { hide(el); ui.hl.hidden = true; }
    }, true);

    setCollapsed(state.collapsed);
  }

  function setCollapsed(on) {
    state.collapsed = on;
    if (!ui) return;
    ui.panel.hidden = on;
    ui.fab.hidden = !on;
    if (on) setHideMode(false);
    updateCount();
  }

  function setHideMode(on) {
    state.hideMode = on;
    if (!ui) return;
    ui.hideBtn.setAttribute('aria-pressed', String(on));
    ui.hl.hidden = true;
    root.style.cursor = on ? 'crosshair' : '';
    if (on) toast('Click an element to hide it. Esc to stop.');
  }

  function updateCount() {
    if (!ui) return;
    const n = state.changed.size, h = state.hidden.length;
    const bits = [];
    if (n) bits.push(n + ' changed');
    if (h) bits.push(h + ' hidden');
    ui.count.textContent = bits.length ? ' ' + bits.join(', ') : ' ' + state.tokens.length + ' tokens';
    ui.fab.textContent = 'Tweaks' + (n + h ? ' (' + (n + h) + ')' : '');
  }

  function renderTokens() {
    if (!ui) return;
    const q = ui.search.value.trim().toLowerCase();
    ui.groups.textContent = '';
    if (!state.tokens.length) {
      ui.groups.innerHTML = '<p class="empty">No design tokens on this page. Nothing is declared as a CSS custom property on :root, so there is nothing to tweak yet. Move colors, type, spacing, radius and motion into :root variables first, then press Rescan.</p>';
      updateCount();
      return;
    }
    const groups = new Map();
    for (const t of state.tokens) {
      if (q && !t.name.toLowerCase().includes(q)) continue;
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group).push(t);
    }
    if (!groups.size) { ui.groups.innerHTML = '<p class="empty">No token matches that filter.</p>'; return; }
    // A hand-made system (up to ~40 tokens) opens fully so every control is one glance
    // away; a big generated set opens only its first two groups.
    const openAll = state.tokens.length <= 40;
    let index = 0;
    for (const [g, toks] of groups) {
      const d = document.createElement('details');
      d.setAttribute('data-group', g);
      const byDefault = openAll || index < 2;
      d.open = !!q || userOpen.has(g) || (byDefault && !userClosed.has(g));
      index++;
      const s = document.createElement('summary');
      s.innerHTML = esc(g) + ' <span class="n">' + toks.length + '</span>';
      // Record only choices the user makes; d.open still holds the old state here.
      s.addEventListener('click', () => {
        if (d.open) { userClosed.add(g); userOpen.delete(g); } else { userOpen.add(g); userClosed.delete(g); }
      });
      d.appendChild(s);
      toks.forEach((t) => d.appendChild(buildRow(t)));
      ui.groups.appendChild(d);
    }
    updateCount();
  }

  function buildRow(t) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('data-name', t.name);
    const id = 'tp' + t.name.replace(/[^a-z0-9_-]/gi, '_');
    const label = document.createElement('label');
    label.htmlFor = id;
    label.title = t.name + ' (was ' + t.original + ')';
    label.textContent = t.name.replace(/^--/, '');
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const current = state.changed.has(t.name) ? state.changed.get(t.name) : t.original;

    if (t.kind === 'color') {
      const rgba = toRGBA(current);
      const pick = document.createElement('input');
      pick.type = 'color';
      pick.id = id;
      pick.setAttribute('aria-label', t.name);
      if (rgba) pick.value = toHex(rgba); else pick.disabled = true;
      const txt = document.createElement('input');
      txt.type = 'text';
      txt.value = current;
      txt.setAttribute('aria-label', t.name + ' value');
      pick.addEventListener('input', () => {
        const c = toRGBA(pick.value);
        const a = (toRGBA(txt.value) || { a: 1 }).a;
        const v = a < 1 ? 'rgb(' + c.r + ' ' + c.g + ' ' + c.b + ' / ' + a + ')' : pick.value;
        txt.value = v;
        setToken(t.name, v, { sync: false });
      });
      txt.addEventListener('change', () => { if (isColor(txt.value.trim())) setToken(t.name, txt.value.trim()); else txt.value = current; });
      ctl.append(pick, txt);
    } else if (t.kind === 'length' || t.kind === 'time' || t.kind === 'number') {
      const r = rangeFor(t.kind, t.original);
      const curNum = parseFloat(current);
      const curUnit = t.kind === 'number' ? '' : ((current.match(t.kind === 'time' ? RE_TIME : RE_LENGTH) || [])[2] || r.unit);
      const range = document.createElement('input');
      range.type = 'range';
      range.id = id;
      range.min = String(Math.min(r.min, curNum));
      range.max = String(Math.max(r.max, curNum));
      range.step = String(r.step);
      range.value = String(isNaN(curNum) ? r.value : curNum);
      range.setAttribute('aria-label', t.name);
      const num = document.createElement('input');
      num.type = 'number';
      num.step = String(r.step);
      num.value = fmt(range.value);
      num.setAttribute('aria-label', t.name + ' value');
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = curUnit;
      const apply = (v) => setToken(t.name, fmt(v) + curUnit, { sync: false });
      range.addEventListener('input', () => { num.value = fmt(range.value); apply(range.value); });
      num.addEventListener('input', () => { if (num.value !== '' && !isNaN(+num.value)) { range.value = num.value; apply(num.value); } });
      ctl.append(range, num, unit);
    } else {
      const txt = document.createElement('input');
      txt.type = 'text';
      txt.id = id;
      txt.value = current;
      txt.setAttribute('aria-label', t.name);
      let timer = 0;
      txt.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => setToken(t.name, txt.value, { sync: false }), 350); });
      txt.addEventListener('change', () => { clearTimeout(timer); setToken(t.name, txt.value, { sync: false }); });
      ctl.append(txt);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset';
    reset.title = 'Reset to ' + t.original;
    reset.setAttribute('aria-label', 'Reset ' + t.name);
    reset.textContent = '\u21BA';
    reset.addEventListener('click', () => setToken(t.name, t.original));
    row.append(label, ctl, reset);
    if (state.changed.has(t.name)) row.classList.add('changed');
    return row;
  }

  function findRow(name) {
    if (!ui) return null;
    for (const r of ui.groups.querySelectorAll('.row')) if (r.getAttribute('data-name') === name) return r;
    return null;
  }

  function markRow(name) {
    const r = findRow(name);
    if (r) r.classList.toggle('changed', state.changed.has(name));
  }

  function syncRow(name) {
    const r = findRow(name);
    const t = tokenByName(name);
    if (r && t) r.replaceWith(buildRow(t));
  }

  function renderHidden() {
    if (!ui) return;
    ui.hiddenList.textContent = '';
    state.hidden.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'h';
      const s = document.createElement('span');
      s.textContent = h.text || h.selector;
      s.title = h.selector;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Show';
      b.setAttribute('aria-label', 'Show ' + (h.text || h.selector));
      b.addEventListener('click', () => unhide(h));
      row.append(s, b);
      ui.hiddenList.appendChild(row);
    });
  }

  let toastTimer = 0;
  function toast(msg) {
    if (!ui) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('on'), 1800);
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(label + ' copied');
      return;
    } catch { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    ui.shadow.appendChild(ta);
    ta.select();
    let ok;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) toast(label + ' copied');
    else showText(text);
  }

  function showText(text) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<div class="box"><p>Copying is blocked here. Select all and copy by hand:</p><textarea readonly></textarea><p><button class="btn" type="button">Close</button></p></div>';
    m.querySelector('textarea').value = text;
    m.querySelector('button').addEventListener('click', () => m.remove());
    ui.shadow.appendChild(m);
    m.querySelector('textarea').select();
  }

  function download() {
    const blob = new Blob([JSON.stringify(exportState(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tweaks-' + ((location.pathname.split('/').pop() || 'page').replace(/\.[a-z0-9]+$/i, '') || 'page') + '.json';
    ui.shadow.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // ---------- boot ----------
  window.tweaks = {
    __panel: true,
    export: exportState,
    css: toCSS,
    list: () => state.tokens.map((t) => ({ name: t.name, kind: t.kind, group: t.group, original: t.original, value: state.changed.has(t.name) ? state.changed.get(t.name) : t.original })),
    set: (name, value) => setToken(name, value),
    reset: resetAll,
    rescan: scan,
    open: () => setCollapsed(false),
    close: () => setCollapsed(true),
  };

  function boot() {
    buildUI();
    scan();
    restore();
    renderTokens();
    renderHidden();
  }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
