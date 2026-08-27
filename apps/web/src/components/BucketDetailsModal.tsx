import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Bucket, type BucketActivity, type BucketDueFrequency, type BucketGroup, type FundingSchedule, type Transaction } from '../lib/api'
import { formatCents } from '@tally/core'
import { useDebouncedPatch } from '../hooks/useDebouncedPatch'

const TYPE_LABEL: Record<Bucket['type'], string> = {
  expense: 'Expense',
  goal: 'Goal',
  vault: 'Vault',
}

const FUNDING_MODE_DESCRIPTION: Record<'set_aside' | 'reach_target', string> = {
  set_aside: 'Sets aside a fixed amount based on the target and pay periods, even after the target is reached.',
  reach_target: 'Adjusts funding to the current balance, pauses at the target, and resumes after a drawdown.',
}

const DUE_FREQUENCY_LABEL: Record<BucketDueFrequency, string> = {
  monthly: 'Monthly',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  quarterly: 'Quarterly',
  semiannual: 'Twice a year',
  annual: 'Annual',
}

const KIND_LABEL: Record<BucketActivity['kind'], string> = {
  funding: 'Funding',
  spend: 'Spend',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  correction: 'Correction',
}

interface Props {
  bucket: Bucket
  schedules: FundingSchedule[]
  allBuckets: Bucket[]
  groups: BucketGroup[]
  budgetId: string
  onClose: () => void
  onSaved: (updated: Bucket) => void
  onDeleted: (id: string) => void
  onBalancesChanged: () => void
}

function dollarsToCents(input: string): number | null {
  const n = Number.parseFloat(input.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function dateForDueDay(dueDay: number | null): string {
  if (dueDay == null) return ''
  return `${new Date().getUTCFullYear()}-01-${String(dueDay).padStart(2, '0')}`
}

function utcDayFromDate(value: string): number | null {
  const [year, month, day] = value.split('-').map(Number)
  if (![year, month, day].every(Number.isInteger)) return null
  const date = new Date(Date.UTC(year!, month! - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) return null
  return date.getUTCDate()
}

/** Extract the server's `error` string out of an ApiError message. */
function serverError(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err)
  try {
    const start = raw.indexOf('{')
    if (start >= 0) {
      const parsed = JSON.parse(raw.slice(start)) as { error?: unknown }
      if (parsed && typeof parsed.error === 'string') return parsed.error
    }
  } catch {
    /* not JSON */
  }
  return null
}

export default function BucketDetailsModal({
  bucket,
  schedules,
  allBuckets,
  groups,
  budgetId,
  onClose,
  onSaved,
  onDeleted,
  onBalancesChanged,
}: Props) {
  const [draft, setDraft] = useState({
    name: bucket.name,
    type: bucket.type,
    targetDollars: formatCents(bucket.targetAmountCents).replace('-', ''),
    dueDay: bucket.dueDay,
    dueDate: bucket.dueDate ?? dateForDueDay(bucket.dueDay),
    dueFrequency: bucket.dueFrequency ?? 'monthly',
    targetDate: bucket.targetDate ?? '',
    fundingMode: bucket.fundingMode ?? 'reach_target',
    scheduleId: bucket.fundingScheduleId ?? '',
    groupId: bucket.bucketGroupId ?? '',
    balanceDollars: formatCents(bucket.currentBalanceCents),
  })
  const versionRef = useRef(bucket.version)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [balanceMsg, setBalanceMsg] = useState<string | null>(null)
  const balanceCentsRef = useRef(bucket.currentBalanceCents)
  const debouncedPatch = useDebouncedPatch<Record<string, unknown>>(
    async (fields) => {
      const updated = await api.patch<Bucket>(
        `/budgets/${bucket.budgetId}/buckets/${bucket.id}`,
        { ...fields, version: versionRef.current },
      )
      versionRef.current = updated.version
      onSaved(updated)
    },
    {
      onStart: () => setSaveState('saving'),
      onSuccess: () => {
        setSaveState('saved')
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaveState('idle'), 1500)
      },
      onError: (err) => {
        setSaveState('error')
        setFieldError(err instanceof Error ? err.message : 'Failed to save')
      },
    },
  )

  // Transfers (secondary modal)
  const [showTransfer, setShowTransfer] = useState(false)
  const [transferToId, setTransferToId] = useState(bucket.id)
  const [transferFromId, setTransferFromId] = useState('')
  const [transferAmount, setTransferAmount] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferMsg, setTransferMsg] = useState<string | null>(null)

  // Activity feed
  const [activity, setActivity] = useState<BucketActivity[] | null>(null)

  // Auto-spend editor state
  const [keywordInput, setKeywordInput] = useState('')
  const [keywordPreview, setKeywordPreview] = useState<string[] | null>(null)
  const [categoryList, setCategoryList] = useState<{ id: string; name: string }[]>([])
  const [showCategories, setShowCategories] = useState(false)
  const matchMerchants = bucket.matchMerchants ?? []
  const matchCategories = bucket.matchCategories ?? []

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (showTransfer) setShowTransfer(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, showTransfer])

  const loadActivity = useCallback(async () => {
    try {
      setActivity(
        await api.get<BucketActivity[]>(`/budgets/${budgetId}/buckets/${bucket.id}/activity`),
      )
    } catch {
      setActivity([]) // non-fatal
    }
  }, [budgetId, bucket.id])

  useEffect(() => {
    void loadActivity()
  }, [loadActivity])

  const debouncedBalance = useDebouncedPatch<{ targetCents: number }>(
    async ({ targetCents }) => {
      const diff = targetCents - balanceCentsRef.current
      if (diff === 0) return
      await api.post(`/budgets/${bucket.budgetId}/transfers`, {
        fromBucketId: diff < 0 ? bucket.id : null,
        toBucketId: diff > 0 ? bucket.id : null,
        amountCents: Math.abs(diff),
      })
      balanceCentsRef.current = targetCents
      setDraft((d) => ({ ...d, balanceDollars: formatCents(targetCents) }))
      onBalancesChanged()
      void loadActivity()
    },
    {
      onStart: () => setSaveState('saving'),
      onSuccess: () => {
        setBalanceMsg(null)
        setSaveState('saved')
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaveState('idle'), 1500)
      },
      onError: (err) => {
        setBalanceMsg(serverError(err) ?? 'Not enough in Free-to-Spend.')
        setDraft((d) => ({ ...d, balanceDollars: formatCents(balanceCentsRef.current) }))
        setSaveState('error')
      },
    },
  )

  // Canonical categories for the auto-spend picker.
  useEffect(() => {
    api.get<{ id: string; name: string }[]>(`/budgets/${budgetId}/categories`)
      .then(setCategoryList)
      .catch(() => setCategoryList([]))
  }, [budgetId])

  // Live preview of transactions matching the keyword being typed.
  useEffect(() => {
    const q = keywordInput.trim()
    if (q.length < 2) {
      setKeywordPreview(null)
      return
    }
    const t = setTimeout(async () => {
      try {
        const rows = await api.get<Transaction[]>(
          `/budgets/${budgetId}/transactions?q=${encodeURIComponent(q)}&limit=5`,
        )
        setKeywordPreview(rows.map((r) => r.merchantDescription))
      } catch {
        setKeywordPreview(null)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [keywordInput, budgetId])

  async function patchMatchRules(fields: {
    matchMerchants?: string[]
    matchCategories?: string[]
  }) {
    debouncedPatch.schedule(bucket.id, fields)
  }

  function addKeyword() {
    const kw = keywordInput.trim().toLowerCase()
    setKeywordInput('')
    if (!kw || matchMerchants.includes(kw)) return
    void patchMatchRules({ matchMerchants: [...matchMerchants, kw] })
  }

  function removeKeyword(kw: string) {
    void patchMatchRules({ matchMerchants: matchMerchants.filter((k) => k !== kw) })
  }

  function toggleCategory(name: string) {
    const next = matchCategories.includes(name)
      ? matchCategories.filter((c) => c !== name)
      : [...matchCategories, name]
    void patchMatchRules({ matchCategories: next })
  }

  // Keep the balance field in sync when balances refresh (transfers, syncs).
  useEffect(() => {
    balanceCentsRef.current = bucket.currentBalanceCents
    setDraft((d) => ({ ...d, balanceDollars: formatCents(bucket.currentBalanceCents) }))
  }, [bucket.currentBalanceCents])

  function patchBucket(fields: Record<string, unknown>) {
    setFieldError(null)
    debouncedPatch.schedule(bucket.id, fields)
    return Promise.resolve()
  }

  function commitName() {
    const name = draft.name.trim()
    if (!name || name === bucket.name) return
    patchBucket({ name }).catch(() => setDraft((d) => ({ ...d, name: bucket.name })))
  }

  function commitTargetAmount() {
    const cents = dollarsToCents(draft.targetDollars)
    if (cents === null || cents < 0) {
      setDraft((d) => ({ ...d, targetDollars: formatCents(bucket.targetAmountCents) }))
      setFieldError('Enter a valid non-negative target amount.')
      return
    }
    if (cents === bucket.targetAmountCents) return
    patchBucket({ targetAmountCents: cents }).catch(() =>
      setDraft((d) => ({ ...d, targetDollars: formatCents(bucket.targetAmountCents) })),
    )
  }

  function commitType(type: Bucket['type']) {
    const dueDay = type === 'expense' ? draft.dueDay : null
    const dueDate = type === 'expense' ? draft.dueDate : ''
    const dueFrequency = type === 'expense' ? draft.dueFrequency : 'monthly'
    const targetDate = type === 'expense' ? '' : draft.targetDate
    setDraft((d) => ({ ...d, type, dueDay, dueDate, dueFrequency, targetDate }))
    setFieldError(null)
    const validConfiguration = type === 'expense'
      ? Boolean(dueDate && dueFrequency)
      : Boolean(targetDate)
    if (type !== bucket.type && validConfiguration) {
      patchBucket({
        type,
        dueDay: null,
        dueDate: type === 'expense' ? dueDate : null,
        dueFrequency: type === 'expense' ? dueFrequency : null,
        targetDate: type === 'expense' ? null : targetDate || null,
      }).catch(() => setDraft((d) => ({
        ...d,
        type: bucket.type,
        dueDay: bucket.dueDay,
        dueDate: bucket.dueDate ?? dateForDueDay(bucket.dueDay),
        dueFrequency: bucket.dueFrequency ?? 'monthly',
        targetDate: bucket.targetDate ?? '',
      })))
    }
  }

  function commitDueDate() {
    if (draft.type === 'expense') {
      if (!draft.dueDate || !draft.dueFrequency) {
        setFieldError('Choose a due date and frequency for this expense.')
        return
      }
      if (
        draft.type === bucket.type &&
        draft.dueDate === bucket.dueDate &&
        draft.dueFrequency === bucket.dueFrequency &&
        bucket.dueDay == null
      ) return
      patchBucket({
        type: draft.type,
        dueDay: null,
        dueDate: draft.dueDate,
        dueFrequency: draft.dueFrequency,
        targetDate: null,
      }).catch(() => setDraft((d) => ({
        ...d,
        type: bucket.type,
        dueDay: bucket.dueDay,
        dueDate: bucket.dueDate ?? dateForDueDay(bucket.dueDay),
        dueFrequency: bucket.dueFrequency ?? 'monthly',
        targetDate: bucket.targetDate ?? '',
      })))
      return
    }

    if (!draft.targetDate) {
      setFieldError(`${TYPE_LABEL[draft.type]} buckets require a due date.`)
      return
    }
    if (draft.targetDate === bucket.targetDate && draft.type === bucket.type) return
    patchBucket({
      type: draft.type,
      targetDate: draft.targetDate,
      dueDay: null,
      dueDate: null,
      dueFrequency: null,
    }).catch(() => setDraft((d) => ({
      ...d,
      type: bucket.type,
      dueDay: bucket.dueDay,
      dueDate: bucket.dueDate ?? dateForDueDay(bucket.dueDay),
      dueFrequency: bucket.dueFrequency ?? 'monthly',
      targetDate: bucket.targetDate ?? '',
    })))
  }

  function commitFundingMode(mode: string) {
    const nextMode = mode as 'set_aside' | 'reach_target'
    const prev = bucket.fundingMode ?? 'reach_target'
    setDraft((d) => ({ ...d, fundingMode: nextMode }))
    if (prev === mode) return
    patchBucket({ fundingMode: nextMode }).catch(() =>
      setDraft((d) => ({ ...d, fundingMode: prev })),
    )
  }

  function commitSchedule(id: string) {
    const prev = bucket.fundingScheduleId ?? ''
    setDraft((d) => ({ ...d, scheduleId: id }))
    if (prev === id) return
    patchBucket({ fundingScheduleId: id === '' ? null : id }).catch(() =>
      setDraft((d) => ({ ...d, scheduleId: prev })),
    )
  }

  /**
   * Manual balance edit: move the difference to/from Free-to-Spend. The server
   * rejects moves that would push FTS negative or overdraw the bucket — we
   * surface that message and snap the field back to the real balance.
   */
  function scheduleBalance(value: string) {
    setDraft((d) => ({ ...d, balanceDollars: value }))
    const cents = dollarsToCents(value)
    if (cents === null) return
    setBalanceMsg(null)
    debouncedBalance.schedule(bucket.id, { targetCents: cents })
  }

  function commitBalance() {
    if (dollarsToCents(draft.balanceDollars) === null) {
      setDraft((d) => ({ ...d, balanceDollars: formatCents(bucket.currentBalanceCents) }))
      setBalanceMsg('Enter a valid amount.')
      return
    }
    void debouncedBalance.flush(bucket.id)
  }

  async function executeTransfer() {
    const cents = dollarsToCents(transferAmount)
    if (cents === null || cents <= 0) {
      setTransferMsg('Enter a positive amount.')
      return
    }
    const fromBucketId = transferFromId || null // '' = FTS
    const toBucketId = transferToId || null
    if (fromBucketId === toBucketId) {
      setTransferMsg('Pick a different destination.')
      return
    }
    setTransferBusy(true)
    setTransferMsg(null)
    try {
      await api.post(`/budgets/${bucket.budgetId}/transfers`, {
        fromBucketId,
        toBucketId,
        amountCents: cents,
      })
      setTransferAmount('')
      setTransferMsg(`Transferred ${formatCents(cents)}.`)
      onBalancesChanged()
      void loadActivity()
    } catch (err) {
      setTransferMsg(serverError(err) ?? 'Transfer failed.')
    } finally {
      setTransferBusy(false)
    }
  }

  async function deleteBucket() {
    if (
      !window.confirm(
        `Delete "${bucket.name}"? Its remaining allocated balance (${formatCents(
          bucket.currentBalanceCents,
        )}) returns to Free-to-Spend.`,
      )
    )
      return
    try {
      await api.del(`/budgets/${bucket.budgetId}/buckets/${bucket.id}`)
      onDeleted(bucket.id)
    } catch (err) {
      setFieldError(serverError(err) ?? 'Failed to delete bucket.')
    }
  }

  const others = allBuckets.filter((b) => b.id !== bucket.id)

  /** Destination options: FTS + every bucket except the source selection. */
  function toOptions() {
    return [{ id: '', name: 'Free-to-Spend' }, ...others.filter((b) => b.id !== transferFromId)]
  }
  /** Source options: FTS + every bucket except the destination selection. */
  function fromOptions() {
    return [{ id: '', name: 'Free-to-Spend' }, ...others.filter((b) => b.id !== transferToId)]
  }

  function swapTransferFields() {
    const to = transferToId
    setTransferToId(transferFromId)
    setTransferFromId(to)
  }

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg space-y-5 overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
        {/* Header: editable name + actions */}
        <div className="flex items-start justify-between gap-2">
          <input
            value={draft.name}
            onChange={(e) => { const name = e.target.value; setDraft((d) => ({ ...d, name })); if (name.trim()) patchBucket({ name: name.trim() }) }}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xl font-semibold hover:border-neutral-400 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex shrink-0 items-center gap-2">
            <button
              title="Transfer money"
              onClick={() => setShowTransfer(true)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              ⇄ Transfer
            </button>
            <button
              title="Delete bucket"
              onClick={() => void deleteBucket()}
              className="rounded-md border border-red-200 p-2 text-red-600 hover:bg-red-50"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-neutral-500">
            Balance:
            <input
              type="text"
              inputMode="decimal"
              value={draft.balanceDollars}
              onChange={(e) => scheduleBalance(e.target.value)}
              onBlur={() => void commitBalance()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              title="Edit to move money to/from Free-to-Spend"
              className="w-28 rounded-md border border-neutral-300 px-2 py-1 text-sm font-medium tabular-nums text-neutral-800 hover:border-neutral-400 focus:border-blue-500 focus:outline-none"
            />
          </label>
          <SaveIndicator state={saveState} />
        </div>
        {balanceMsg && <p className="text-sm text-red-600">{balanceMsg}</p>}
        {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}

        {/* Editable fields */}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Type
            <select
              value={draft.type}
              onChange={(e) => commitType(e.target.value as Bucket['type'])}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
            >
              {Object.entries(TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Target amount
            <input
              type="text"
              inputMode="decimal"
              value={draft.targetDollars}
              onChange={(e) => { const targetDollars = e.target.value; setDraft((d) => ({ ...d, targetDollars })); const cents = dollarsToCents(targetDollars); if (cents != null && cents >= 0) patchBucket({ targetAmountCents: cents }) }}
              onBlur={commitTargetAmount}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
            />
          </label>

          {draft.type === 'expense' ? (
            <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Due date
              <input
                type="date"
                value={draft.dueDate}
                onChange={(e) => { const dueDate = e.target.value; const dueDay = utcDayFromDate(dueDate); setDraft((d) => ({ ...d, dueDate, dueDay })); if (dueDate) patchBucket({ type: 'expense', dueDate, dueFrequency: draft.dueFrequency, dueDay: null, targetDate: null }) }}
                onBlur={commitDueDate}
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
              />
              <span className="mt-1 block font-normal normal-case tracking-normal text-neutral-400">
                Anchors the {DUE_FREQUENCY_LABEL[draft.dueFrequency].toLowerCase()} recurrence.
              </span>
            </label>
          ) : (
            <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Due date
              <input
                type="date"
                value={draft.targetDate}
                onChange={(e) => { const targetDate = e.target.value; setDraft((d) => ({ ...d, targetDate })); if (targetDate) patchBucket({ type: draft.type, targetDate, dueDate: null, dueFrequency: null, dueDay: null }) }}
                onBlur={commitDueDate}
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
              />
            </label>
          )}

          {draft.type === 'expense' && (
            <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Frequency
              <select
                value={draft.dueFrequency}
                onChange={(e) => { const dueFrequency = e.target.value as BucketDueFrequency; setDraft((d) => ({ ...d, dueFrequency })); if (draft.dueDate) patchBucket({ type: 'expense', dueDate: draft.dueDate, dueFrequency, dueDay: null, targetDate: null }) }}
                onBlur={commitDueDate}
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
              >
                {(Object.keys(DUE_FREQUENCY_LABEL) as BucketDueFrequency[]).map((frequency) => (
                  <option key={frequency} value={frequency}>{DUE_FREQUENCY_LABEL[frequency]}</option>
                ))}
              </select>
            </label>
          )}

          <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Funding option
              <select
                value={draft.fundingMode}
                onChange={(e) => commitFundingMode(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
              >
                <option value="set_aside">Set aside each period</option>
                <option value="reach_target">Reach target, then pause</option>
              </select>
              <span className="mt-1 block font-normal normal-case tracking-normal text-neutral-400">
                {FUNDING_MODE_DESCRIPTION[draft.fundingMode as 'set_aside' | 'reach_target']}
              </span>
            </label>

          <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Bucket group
            <select
              value={draft.groupId ?? bucket.bucketGroupId ?? ''}
              onChange={(e) => {
                setDraft((d) => ({ ...d, groupId: e.target.value }))
                const id = e.target.value === '' ? null : e.target.value
                if (id !== (bucket.bucketGroupId ?? null)) {
                  patchBucket({ bucketGroupId: id }).catch(() =>
                    setDraft((d) => ({ ...d, groupId: bucket.bucketGroupId ?? '' })),
                  )
                }
              }}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
            >
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Funding schedule
            <select
              value={draft.scheduleId}
              onChange={(e) => commitSchedule(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
            >
              <option value="">No schedule</option>
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Auto-spend */}
        <div className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-1 text-sm font-semibold">Auto-spend</h3>
          <p className="mb-2 text-xs text-neutral-500">
            Transactions matching a keyword or category are automatically assigned to this bucket.
          </p>

          <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Keywords
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addKeyword()
                }
              }}
              placeholder='e.g. "netflix"'
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <button
              onClick={addKeyword}
              disabled={!keywordInput.trim()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {keywordPreview && (
            <div className="mt-1 rounded-md border border-neutral-200 bg-neutral-50 p-2">
              <p className="text-xs text-neutral-500">
                {keywordPreview.length > 0 ? 'Matches:' : 'No matching transactions.'}
              </p>
              <ul className="mt-1 space-y-0.5">
                {keywordPreview.map((d) => (
                  <li key={d} className="truncate text-xs text-neutral-600">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {matchMerchants.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {matchMerchants.map((kw) => (
                <span
                  key={kw}
                  className="flex items-center gap-1 rounded-full bg-neutral-100 py-0.5 pl-2.5 pr-1.5 text-xs text-neutral-700"
                >
                  {kw}
                  <button
                    onClick={() => removeKeyword(kw)}
                    title={`Remove "${kw}"`}
                    className="text-neutral-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3">
            <button
              onClick={() => setShowCategories((v) => !v)}
              className="text-xs font-medium uppercase tracking-wide text-neutral-400 hover:text-neutral-600"
            >
              Categories {showCategories ? '▾' : '▸'}
              {matchCategories.length > 0 && (
                <span className="ml-1 normal-case tracking-normal text-blue-600">
                  ({matchCategories.length} selected)
                </span>
              )}
            </button>
            {showCategories && (
              <ul className="mt-1 grid max-h-40 grid-cols-2 gap-x-3 overflow-y-auto rounded-md border border-neutral-200 p-2">
                {categoryList.map((c) => (
                  <li key={c.id}>
                    <label className="flex items-center gap-1.5 py-0.5 text-sm text-neutral-700">
                      <input
                        type="checkbox"
                        checked={matchCategories.includes(c.name)}
                        onChange={() => toggleCategory(c.name)}
                      />
                      <span className="truncate">{c.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>


        {/* Activity */}
        <div className="rounded-lg border border-neutral-200">
          <h3 className="border-b border-neutral-100 px-4 py-2 text-sm font-semibold">Activity</h3>
          {activity === null ? (
            <p className="px-4 py-3 text-sm text-neutral-400">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="px-4 py-3 text-sm text-neutral-500">No money movement yet.</p>
          ) : (
            <ul className="max-h-56 divide-y divide-neutral-100 overflow-y-auto">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="block truncate">
                      {a.kind === 'funding' ? (a.scheduleName ?? 'Funding') : (a.description ?? KIND_LABEL[a.kind])}
                    </span>
                    <span className="text-xs text-neutral-400">
                      {KIND_LABEL[a.kind]}
                      {a.kind === 'transfer_in' && a.counterpartName
                        ? ` from ${a.counterpartName}`
                        : ''}
                      {a.kind === 'transfer_out' && a.counterpartName
                        ? ` to ${a.counterpartName}`
                        : ''}
                      {' · '}
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 tabular-nums ${
                      a.amountCents < 0 ? 'text-red-600' : 'text-green-600'
                    }`}
                  >
                    {formatCents(a.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Secondary modal: transfer money */}
      {showTransfer && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowTransfer(false)
          }}
        >
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold">Transfer money</h2>
            <p className="text-sm text-neutral-500">
              Move money into or out of <span className="font-medium">{bucket.name}</span>.
            </p>
            <div className="grid grid-cols-[1fr_auto_1fr items-end gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                To
                <select
                  value={transferToId}
                  onChange={(e) => setTransferToId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-2 text-sm normal-case tracking-normal text-neutral-800"
                >
                  {toOptions().map((b) => (
                    <option key={b.id || 'fts'} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                title="Swap"
                onClick={swapTransferFields}
                className="mb-0.5 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-50"
              >
                ⇄
              </button>
              <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                From
                <select
                  value={transferFromId}
                  onChange={(e) => setTransferFromId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-2 text-sm normal-case tracking-normal text-neutral-800"
                >
                  {fromOptions().map((b) => (
                    <option key={b.id || 'fts'} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <input
              type="text"
              inputMode="decimal"
              placeholder="Amount ($)"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              className="w-full rounded-md border border-neutral-300 px-2 py-2 text-sm"
            />
            <button
              onClick={() => void executeTransfer()}
              disabled={transferBusy || !transferAmount}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {transferBusy ? 'Transferring…' : 'Transfer'}
            </button>
            {transferMsg && <p className="text-sm text-neutral-700">{transferMsg}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'idle') return null
  if (state === 'saving') return <span className="text-xs text-neutral-400">Saving…</span>
  if (state === 'saved') return <span className="text-xs text-green-600">Saved ✓</span>
  return <span className="text-xs text-red-600">Save failed</span>
}
