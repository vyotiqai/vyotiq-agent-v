/**
 * Compact composer/toolbar chrome text.
 * Avoid truncate + leading-none on short labels — that clips Plus Jakarta Sans
 * descenders (g reads as q → “Aqent”).
 */
export const chromeLabelText =
  'text-xs leading-tight tracking-normal'

/** 32px chrome row — banner-style strips (dictation error banner). */
export const chromeRow = 'flex h-8 min-w-0 items-center gap-1.5'
