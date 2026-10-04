/**
 * Range parsing and extension mapping for the media scheme
 * (src/main/video/serveFile.ts). A <video> seeks entirely through this.
 */

import { describe, expect, it } from 'vitest'

import { mediaKindForPath, mediaMimeForPath, parseByteRange } from '@main/video/serveFile'

const SIZE = 1000

describe('parseByteRange', () => {
  it('returns null when the header is absent', () => {
    expect(parseByteRange(null, SIZE)).toBeNull()
    expect(parseByteRange('', SIZE)).toBeNull()
  })

  it('parses a plain range', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 })
    expect(parseByteRange('  bytes=100-199  ', SIZE)).toEqual({ start: 100, end: 199 })
  })

  it('parses the suffix form as the last N bytes', () => {
    expect(parseByteRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 })
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 })
  })

  it('parses an open-ended range as to the end of the file', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 })
  })

  it('clamps an end beyond the file size', () => {
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 })
  })

  it('reports unsatisfiable for a start past the end, a start past the file, and a zero suffix', () => {
    expect(parseByteRange('bytes=600-100', SIZE)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=1500-1600', SIZE)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', SIZE)).toBe('unsatisfiable')
  })

  it('returns null for a malformed header', () => {
    expect(parseByteRange('items=0-10', SIZE)).toBeNull()
    expect(parseByteRange('bytes=abc-def', SIZE)).toBeNull()
    expect(parseByteRange('bytes=-', SIZE)).toBeNull()
    expect(parseByteRange('0-499', SIZE)).toBeNull()
  })
})

describe('mediaMimeForPath / mediaKindForPath', () => {
  it('maps a representative video, audio and image extension', () => {
    expect(mediaMimeForPath('/runs/out.mp4')).toBe('video/mp4')
    expect(mediaKindForPath('/runs/out.mp4')).toBe('video')
    expect(mediaMimeForPath('/runs/theme.mp3')).toBe('audio/mpeg')
    expect(mediaKindForPath('/runs/theme.mp3')).toBe('audio')
    expect(mediaMimeForPath('/runs/poster.png')).toBe('image/png')
    expect(mediaKindForPath('/runs/poster.png')).toBe('image')
  })

  it('lowercases the extension before matching', () => {
    expect(mediaMimeForPath('C:\\Runs\\Clip.MP4')).toBe('video/mp4')
    expect(mediaKindForPath('C:\\Runs\\Clip.MOV')).toBe('video')
    expect(mediaKindForPath('/runs/still.JPEG')).toBe('image')
  })

  it('returns null for an unknown or absent extension', () => {
    expect(mediaMimeForPath('/runs/notes.txt')).toBeNull()
    expect(mediaKindForPath('/runs/notes.txt')).toBeNull()
    expect(mediaMimeForPath('/runs/README')).toBeNull()
    expect(mediaKindForPath('/runs/README')).toBeNull()
  })
})