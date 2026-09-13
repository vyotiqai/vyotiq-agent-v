import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { normalizeBrowserUrl } from '@main/app/browserUrl'
import { isSyncBlockedUrl } from '@main/agent/tools/webFetch'

describe('normalizeBrowserUrl', () => {
  it('accepts localhost and loopback', () => {
    expect(normalizeBrowserUrl('http://localhost:3000/path').href).toBe('http://localhost:3000/path')
    expect(normalizeBrowserUrl('http://127.0.0.1:8080').href).toBe('http://127.0.0.1:8080/')
  })

  it('accepts private LAN hosts', () => {
    expect(normalizeBrowserUrl('http://192.168.1.42/admin').href).toBe(
      'http://192.168.1.42/admin'
    )
    expect(normalizeBrowserUrl('http://10.0.0.5').href).toBe('http://10.0.0.5/')
  })

  it('adds https scheme when missing', () => {
    expect(normalizeBrowserUrl('example.com').href).toBe('https://example.com/')
  })

  it('rejects empty and non-http(s) schemes', () => {
    expect(() => normalizeBrowserUrl('')).toThrow(/required/i)
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow(/Unsupported URL scheme/)
  })
})

describe('normalizeBrowserUrl file: workspace scope', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'vy-browser-file-'))
  const sub = join(tmpRoot, 'my site')
  let outsideFile = ''

  beforeAll(() => {
    writeFileSync(join(tmpRoot, 'index.html'), '<h1>hi</h1>')
    mkdirSync(sub)
    writeFileSync(join(sub, 'page.html'), '<p>space dir</p>')
    outsideFile = join(mkdtempSync(join(tmpdir(), 'vy-browser-out-')), 'secret.html')
    writeFileSync(outsideFile, 'nope')
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(dirname(outsideFile), { recursive: true, force: true })
  })

  it('accepts a file: URL inside the workspace root', () => {
    expect(
      normalizeBrowserUrl(pathToFileURL(join(tmpRoot, 'index.html')).href, {
        workspaceRoot: tmpRoot
      }).protocol
    ).toBe('file:')
  })

  it('accepts percent-encoded paths inside the root (workspaces contain spaces)', () => {
    expect(
      normalizeBrowserUrl(pathToFileURL(join(sub, 'page.html')).href, { workspaceRoot: tmpRoot })
        .protocol
    ).toBe('file:')
  })

  it('rejects file: URLs outside the workspace root', () => {
    expect(() =>
      normalizeBrowserUrl(pathToFileURL(outsideFile).href, { workspaceRoot: tmpRoot })
    ).toThrow(/inside the workspace/i)
    expect(() => normalizeBrowserUrl('file:///C:/etc/passwd', { workspaceRoot: tmpRoot })).toThrow(
      /inside the workspace/i
    )
  })

  it('rejects traversal out of the workspace root', () => {
    // The WHATWG URL parser collapses literal `/../` and %2e%2e dot-segments
    // while parsing, so a surviving escape needs an encoded separator inside
    // a segment: %2F decodes to `/` after normalization (re-introducing `..`)
    // and %5C is a backslash the Windows filesystem honors as a separator.
    expect(() =>
      normalizeBrowserUrl(
        pathToFileURL(join(tmpRoot, 'index.html')).href.replace('index.html', '..%2Fsecret.html'),
        { workspaceRoot: tmpRoot }
      )
    ).toThrow(/inside the workspace/i)
    expect(() =>
      normalizeBrowserUrl(
        pathToFileURL(join(tmpRoot, 'index.html')).href.replace(
          'index.html',
          '%2e%2e%2f%2e%2e%2fsecret.html'
        ),
        { workspaceRoot: tmpRoot }
      )
    ).toThrow(/inside the workspace/i)
    expect(() =>
      normalizeBrowserUrl(
        pathToFileURL(join(tmpRoot, 'index.html')).href.replace('index.html', '%5C..%5Csecret.html'),
        { workspaceRoot: tmpRoot }
      )
    ).toThrow(/inside the workspace/i)
  })

  it('still rejects file: without a workspace root', () => {
    expect(() =>
      normalizeBrowserUrl(pathToFileURL(join(tmpRoot, 'index.html')).href)
    ).toThrow(/Unsupported URL scheme/)
  })

  it('keeps http(s) behavior byte-identical', () => {
    expect(normalizeBrowserUrl('example.com', { workspaceRoot: tmpRoot }).protocol).toBe('https:')
    expect(() => normalizeBrowserUrl('ftp://example.com/x', { workspaceRoot: tmpRoot })).toThrow(
      /Unsupported URL scheme/
    )
  })
})

describe('Ask/Plan browser URL gate', () => {
  it('blocks private hosts when allowLocal is false', () => {
    expect(isSyncBlockedUrl('http://127.0.0.1:8080', false)).toBe(true)
    expect(isSyncBlockedUrl('http://localhost/x', false)).toBe(true)
    expect(isSyncBlockedUrl('http://192.168.1.1/', false)).toBe(true)
    expect(isSyncBlockedUrl('https://example.com/', false)).toBe(false)
  })

  it('allows private hosts when allowLocal is true (Agent)', () => {
    expect(isSyncBlockedUrl('http://127.0.0.1:8080', true)).toBe(false)
    expect(isSyncBlockedUrl('http://192.168.1.1/', true)).toBe(false)
  })

  it('blocks file: for in-page navigation in every mode (front-door only)', () => {
    expect(isSyncBlockedUrl('file:///C:/work/demo/index.html', false)).toBe(true)
    expect(isSyncBlockedUrl('file:///C:/work/demo/index.html', true)).toBe(true)
  })
})
