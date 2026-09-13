import { useState } from 'react'
import { Button, MarkdownContent } from '@renderer/lib/ui'
import { TextCodeEditor } from '@renderer/features/chat/components/TextCodeEditor'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'

type BodyMode = 'source' | 'preview'

export function MarketplaceMarkdownBody({
  path,
  value,
  onChange,
  disabled
}: {
  path: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}) {
  const [mode, setMode] = useState<BodyMode>('source')
  const [cursor, setCursor] = useState(0)
  const [selections, setSelections] = useState([{ from: 0, to: 0 }])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className="flex gap-1"
        role="tablist"
        aria-label="Body view"
        tabIndex={-1}
        onKeyDown={(e) =>
          handleTabListKeyDown(e, {
            tabs: ['source', 'preview'],
            activeId: mode,
            onSelect: (id) => setMode(id as BodyMode)
          })
        }
      >
        {(['source', 'preview'] as const).map((item) => (
          <Button
            key={item}
            id={`marketplace-body-tab-${item}`}
            role="tab"
            aria-selected={mode === item}
            aria-controls={`marketplace-body-panel-${item}`}
            tabIndex={mode === item ? 0 : -1}
            variant="subtle"
            className={mode === item ? 'bg-surface text-fg-strong ring-1 ring-inset ring-border/50' : undefined}
            onClick={() => setMode(item)}
          >
            {item === 'source' ? 'Source' : 'Preview'}
          </Button>
        ))}
      </div>
      {mode === 'source' ? (
        <div
          id="marketplace-body-panel-source"
          role="tabpanel"
          aria-labelledby="marketplace-body-tab-source"
          className="min-h-[12rem] overflow-hidden rounded-md border border-border bg-bg"
        >
          <TextCodeEditor
            path={path}
            value={value}
            cursor={cursor}
            selections={selections}
            onChange={(next) => {
              if (disabled) return false
              onChange(next)
              return true
            }}
            onMetaChange={(meta) => {
              setCursor(meta.cursor)
              setSelections(meta.selections)
            }}
          />
        </div>
      ) : (
        <div
          id="marketplace-body-panel-preview"
          role="tabpanel"
          aria-labelledby="marketplace-body-tab-preview"
          className="min-h-[12rem] overflow-auto rounded-md border border-border bg-bg px-3 py-2"
        >
          {value.trim() ? (
            <MarkdownContent content={value} className="text-sm" />
          ) : (
            <p className="m-0 text-xs text-muted">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
