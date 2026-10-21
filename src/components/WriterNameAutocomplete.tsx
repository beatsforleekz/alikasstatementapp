'use client'

import { useState } from 'react'

interface WriterNameAutocompleteProps {
  value: string
  options: string[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  multiple?: boolean
}

export function WriterNameAutocomplete({
  value,
  options,
  onChange,
  className = 'ops-input',
  placeholder,
  multiple = false,
}: WriterNameAutocompleteProps) {
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const parts = multiple ? value.split(',') : [value]
  const query = (parts.at(-1) ?? '').trim()
  const selected = new Set(
    (multiple ? parts.slice(0, -1) : [])
      .map(part => part.trim().toLocaleLowerCase())
      .filter(Boolean),
  )
  const matches = options
    .filter(option => !selected.has(option.toLocaleLowerCase()))
    .filter(option => !query || option.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .slice(0, 12)

  const choose = (name: string) => {
    if (multiple) {
      const previous = parts.slice(0, -1).map(part => part.trim()).filter(Boolean)
      onChange([...previous, name].join(', '))
    } else {
      onChange(name)
    }
    setHighlighted(0)
    setOpen(false)
  }

  return (
    <div className="relative">
      <input
        className={className}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={event => {
          onChange(event.target.value)
          setHighlighted(0)
          setOpen(true)
        }}
        onKeyDown={event => {
          if (!open || matches.length === 0) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlighted(index => Math.min(index + 1, matches.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlighted(index => Math.max(index - 1, 0))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            choose(matches[highlighted] ?? matches[0])
          } else if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && matches.length > 0 && (
        <div
          className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border shadow-xl"
          style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}
        >
          {matches.map((name, index) => (
            <button
              key={name}
              type="button"
              className="block w-full px-3 py-2 text-left text-xs"
              style={{
                color: 'var(--ops-text)',
                background: index === highlighted ? 'var(--ops-surface-2)' : 'transparent',
              }}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => choose(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
