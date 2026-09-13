import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-vy-text-entry
        className={cn(
          'max-h-40 min-h-[26px] w-full resize-none border-none bg-transparent py-1.5 text-sm leading-[1.4] outline-none placeholder:text-muted',
          'disabled:vy-disabled-state focus-visible:vy-focus-ring',
          className
        )}
        rows={1}
        {...props}
      />
    )
  }
)
