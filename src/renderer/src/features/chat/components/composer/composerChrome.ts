/**
 * Compact composer/toolbar chrome text.
 * Avoid truncate + leading-none on short labels — that clips Plus Jakarta Sans
 * descenders (g reads as q → “Aqent”).
 */
export const chromeLabelText =
  'text-xs leading-tight tracking-normal'

export const chromePillButton = [
  'inline-flex h-7 items-center rounded-md px-1',
  chromeLabelText,
  'bg-transparent border-0',
  'vy-transition hover:bg-surface hover:text-fg active:bg-surface',
  'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
].join(' ')

/** 28px icon control — idle plus/mic and dictation plus/cancel/confirm. */
export const chromeIconButton =
  'inline-grid size-7 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted vy-transition hover:bg-surface hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] disabled:hover:bg-transparent disabled:hover:text-muted'

/** 32px chrome row — banner-style strips (dictation error banner). */
export const chromeRow = 'flex h-8 min-w-0 items-center gap-1.5'
