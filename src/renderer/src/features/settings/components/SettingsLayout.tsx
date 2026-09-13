import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'
import {
  SETTINGS_COLUMN,
  SETTINGS_GUTTER,
  SETTINGS_NAV_WIDTH
} from '@renderer/lib/utils/layout'

export function SettingsLayout({
  back,
  search,
  nav,
  children
}: {
  back: ReactNode
  search: ReactNode
  nav: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-transparent pt-9 animate-fade-in"
      data-settings-shell
    >
      <div
        className="relative z-dropdown flex shrink-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3 sm:px-4 sm:py-2.5"
        data-settings-header
      >
        <div className={cn('flex shrink-0 items-center', SETTINGS_NAV_WIDTH)}>{back}</div>
        <div className="relative min-w-0 flex-1">{search}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {nav}
        <div
          className="flex min-w-0 flex-1 flex-col overflow-auto bg-transparent"
          data-settings-content
        >
          <div className={cn('flex w-full flex-col', SETTINGS_GUTTER, SETTINGS_COLUMN)}>
            <div className="flex flex-col pb-10 pt-1">{children}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
