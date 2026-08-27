import { useCallback, useEffect, useRef } from 'react'

export const AUTOSAVE_DELAY_MS = 600

interface Options {
  onStart?: () => void
  onSuccess?: () => void
  onError?: (error: unknown) => void
}

/** Coalesces field edits independently per entity and serializes each entity's requests. */
export function useDebouncedPatch<T extends Record<string, unknown>>(
  save: (patch: T) => Promise<void>,
  options: Options = {},
) {
  const saveRef = useRef(save)
  const optionsRef = useRef(options)
  const entriesRef = useRef(new Map<string, {
    pending: Partial<T> | null
    timer: ReturnType<typeof setTimeout> | null
    saving: boolean
  }>())

  saveRef.current = save
  optionsRef.current = options

  const flush = useCallback(async (key: string) => {
    const entry = entriesRef.current.get(key)
    if (!entry || entry.saving || !entry.pending) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    const patch = entry.pending
    entry.pending = null
    entry.saving = true
    try {
      optionsRef.current.onStart?.()
      await saveRef.current(patch as T)
      optionsRef.current.onSuccess?.()
    } catch (error) {
      optionsRef.current.onError?.(error)
    } finally {
      entry.saving = false
      if (entry.pending) void flush(key)
    }
  }, [])

  const schedule = useCallback((key: string, patch: Partial<T>) => {
    let entry = entriesRef.current.get(key)
    if (!entry) {
      entry = { pending: null, timer: null, saving: false }
      entriesRef.current.set(key, entry)
    }
    entry.pending = { ...entry.pending, ...patch }
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void flush(key), AUTOSAVE_DELAY_MS)
  }, [flush])

  const cancel = useCallback((key: string) => {
    const entry = entriesRef.current.get(key)
    if (!entry || entry.saving) return
    if (entry.timer) clearTimeout(entry.timer)
    entriesRef.current.delete(key)
  }, [])

  useEffect(() => () => {
    for (const [key, entry] of entriesRef.current) {
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.pending && !entry.saving) void flush(key)
    }
  }, [flush])

  return { schedule, flush, cancel }
}
