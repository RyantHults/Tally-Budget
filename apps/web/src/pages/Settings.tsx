import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type FundingSchedule, type SimpleFinClaimResult, type StoredCredential } from '../lib/api'
import { useAuth } from '../stores/auth'
import { useDebouncedPatch } from '../hooks/useDebouncedPatch'

export default function Settings() {
  const { budgets, activeBudgetId } = useAuth()
  const [credentials, setCredentials] = useState<StoredCredential[]>([])
  const [error, setError] = useState<string | null>(null)

  const [token, setToken] = useState('')
  const [claimBudgetId, setClaimBudgetId] = useState(activeBudgetId ?? '')
  const [claiming, setClaiming] = useState(false)
  const [claimResult, setClaimResult] = useState<SimpleFinClaimResult | null>(null)

  // Funding schedules state
  const [schedules, setSchedules] = useState<FundingSchedule[]>([])
  const [schedForm, setSchedForm] = useState({
    name: '',
    frequency: 'monthly' as
      | 'weekly'
      | 'biweekly'
      | 'monthly'
      | 'yearly'
      | 'semimonthly_day_eom'
      | 'semimonthly_start_day',
    anchorDate: '',
  })
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null)
  const [schedBusy, setSchedBusy] = useState(false)
  const [schedError, setSchedError] = useState<string | null>(null)
  const [schedSuccess, setSchedSuccess] = useState(false)
  const scheduleAutosave = useDebouncedPatch<{
    id: string
    name: string
    recurrenceRule: string
    anchorDate: string
  }>(async ({ id, ...fields }) => {
    if (!activeBudgetId) return
    const updated = await api.patch<FundingSchedule>(`/budgets/${activeBudgetId}/funding-schedules/${id}`, fields)
    setSchedules((prev) => prev.map((s) => s.id === updated.id ? updated : s))
  }, {
    onStart: () => setSchedBusy(true),
    onSuccess: () => { setSchedBusy(false); setSchedSuccess(true) },
    onError: (err) => { setSchedBusy(false); setSchedError(extractError(err)) },
  })

  const loadCredentials = useCallback(async () => {
    setCredentials(await api.get<StoredCredential[]>('/settings/credentials'))
  }, [])

  const loadSchedules = useCallback(async () => {
    if (!activeBudgetId) return
    try {
      const list = await api.get<FundingSchedule[]>(`/budgets/${activeBudgetId}/funding-schedules`)
      setSchedules(list)
    } catch {
      // Non-fatal
    }
  }, [activeBudgetId])

  useEffect(() => {
    loadCredentials().catch(() => setError('Failed to load credentials.'))
    loadSchedules()
  }, [loadCredentials, loadSchedules])

  // Sync default budget when activeBudgetId changes
  useEffect(() => {
    if (activeBudgetId) {
      setClaimBudgetId((prev) => prev || activeBudgetId)
    }
  }, [activeBudgetId])

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim() || !claimBudgetId) return
    setClaiming(true)
    setError(null)
    setClaimResult(null)
    try {
      const result = await api.post<SimpleFinClaimResult>('/integrations/simplefin/claim', {
        setupToken: token.trim(),
        budgetId: claimBudgetId,
      })
      setClaimResult(result)
      setToken('')
      await loadCredentials()
    } catch (err) {
      setError(extractError(err))
    } finally {
      setClaiming(false)
    }
  }

  async function removeCredential(providerName: string) {
    await api.del(`/settings/credentials/${providerName}`).catch(() => undefined)
    await loadCredentials()
  }

  function humanizeRule(rule: string): string {
    const map: Record<string, string> = {
      weekly: 'Every week',
      biweekly: 'Every 2 weeks',
      monthly: 'Monthly',
      yearly: 'Every year',
    }
    if (map[rule]) return map[rule]
    const smMatch = rule.match(/^semimonthly:(.+),(.+)$/)
    if (smMatch && smMatch[1] !== undefined && smMatch[2] !== undefined) {
      const fmt = (v: string) => (v === 'eom' ? 'end of month' : ordinal(v))
      return `${fmt(smMatch[1])} & ${fmt(smMatch[2])}`
    }
    return rule
  }

  function ordinal(n: string): string {
    const num = parseInt(n, 10)
    if (isNaN(num)) return n
    const suffixes = ['th', 'st', 'nd', 'rd']
    const v = num % 100
    return num + (suffixes[(v - 20) % 10] || 'th')
  }

  /** Day-of-month extracted from the picked date (for semimonthly rules). */
  function dayFromDate(dateStr: string): number | null {
    const d = new Date(`${dateStr}T00:00:00`)
    return Number.isNaN(d.getTime()) ? null : d.getDate()
  }

  function buildRecurrenceRule(): string | null {
    switch (schedForm.frequency) {
      case 'weekly':
        return 'weekly'
      case 'biweekly':
        return 'biweekly'
      case 'monthly':
        return 'monthly'
      case 'yearly':
        return 'yearly'
      case 'semimonthly_day_eom': {
        const day = dayFromDate(schedForm.anchorDate)
        return day ? `semimonthly:${day},eom` : null
      }
      case 'semimonthly_start_day': {
        const day = dayFromDate(schedForm.anchorDate)
        return day ? `semimonthly:1,${day}` : null
      }
    }
  }

  function queueScheduleEdit(next: Partial<typeof schedForm>) {
    const nextForm = { ...schedForm, ...next }
    setSchedForm(nextForm)
    if (!editingScheduleId || !nextForm.name.trim() || !nextForm.anchorDate) return
    let rule: string | null = null
    if (['weekly', 'biweekly', 'monthly', 'yearly'].includes(nextForm.frequency)) {
      rule = nextForm.frequency
    } else {
      const day = dayFromDate(nextForm.anchorDate)
      if (day) rule = nextForm.frequency === 'semimonthly_day_eom' ? `semimonthly:${day},eom` : `semimonthly:1,${day}`
    }
    if (rule) scheduleAutosave.schedule(editingScheduleId, { id: editingScheduleId, name: nextForm.name.trim(), recurrenceRule: rule, anchorDate: nextForm.anchorDate })
  }

  async function deleteSchedule(s: FundingSchedule) {
    if (!activeBudgetId) return
    if (
      !window.confirm(
        `Delete "${s.name}"? Buckets using it will keep their balances but stop auto-funding.`,
      )
    )
      return
    try {
      await api.del(`/budgets/${activeBudgetId}/funding-schedules/${s.id}`)
      setSchedules((prev) => prev.filter((x) => x.id !== s.id))
    } catch (err) {
      setSchedError(extractError(err))
    }
  }

  function startEditSchedule(s: FundingSchedule) {
    let frequency: typeof schedForm.frequency = 'monthly'
    if (s.recurrenceRule === 'semimonthly:1' || s.recurrenceRule.startsWith('semimonthly:1,')) {
      frequency = 'semimonthly_start_day'
    } else if (s.recurrenceRule.startsWith('semimonthly:')) {
      frequency = 'semimonthly_day_eom'
    } else if (['weekly', 'biweekly', 'monthly', 'yearly'].includes(s.recurrenceRule)) {
      frequency = s.recurrenceRule as typeof schedForm.frequency
    }
    setEditingScheduleId(s.id)
    setSchedForm({ name: s.name, frequency, anchorDate: s.anchorDate })
    setSchedSuccess(false)
    setSchedError(null)
  }

  function cancelScheduleEdit() {
    setEditingScheduleId(null)
    setSchedForm({ name: '', frequency: 'monthly', anchorDate: '' })
  }

  async function handleScheduleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!activeBudgetId) return
    setSchedBusy(true)
    setSchedError(null)
    setSchedSuccess(false)
    try {
      const rule = buildRecurrenceRule()
      if (!rule) {
        setSchedError('Pick a date so we know which day of the month to use.')
        setSchedBusy(false)
        return
      }
      if (editingScheduleId) {
        const updated = await api.patch<FundingSchedule>(
          `/budgets/${activeBudgetId}/funding-schedules/${editingScheduleId}`,
          { name: schedForm.name, recurrenceRule: rule, anchorDate: schedForm.anchorDate },
        )
        setSchedules((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
        setSchedSuccess(true)
      } else {
        const created = await api.post<FundingSchedule>(
          `/budgets/${activeBudgetId}/funding-schedules`,
          {
            name: schedForm.name,
            recurrenceRule: rule,
            anchorDate: schedForm.anchorDate,
          },
        )
        setSchedules((prev) => [...prev, created])
        setSchedSuccess(true)
      }
      setEditingScheduleId(null)
      setSchedForm({ name: '', frequency: 'monthly', anchorDate: '' })
      setTimeout(() => setSchedSuccess(false), 3000)
    } catch (err) {
      setSchedError(extractError(err))
    } finally {
      setSchedBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-3 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="font-medium">Bank connection (SimpleFin)</h2>
        <p className="text-sm text-neutral-600">
          Create a setup token at{' '}
          <a
            href="https://bridge.simplefin.org/simplefin/create"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline"
          >
            bridge.simplefin.org
          </a>{' '}
          then paste it below to link your accounts.
        </p>

        <form onSubmit={handleClaim} className="flex flex-wrap gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="SimpleFin setup token"
            autoComplete="off"
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <select
            value={claimBudgetId}
            onChange={(e) => setClaimBudgetId(e.target.value)}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={claiming || !token.trim() || !claimBudgetId}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {claiming ? 'Linking…' : 'Link accounts'}
          </button>
        </form>

        {claimResult && (
          <div className="space-y-2">
            {claimResult.reusedExistingConnection && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Setup token was already used — using the existing connection.
              </p>
            )}
            <p className="text-sm text-green-700">
              Linked {claimResult.linkedCount} of {claimResult.totalDiscovered} discovered accounts.{' '}
              <Link to="/accounts" className="underline">
                Manage them on the Accounts page.
              </Link>
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        {credentials.length > 0 && (
          <div className="border-t border-neutral-100 pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Stored credentials
            </h3>
            <ul className="divide-y divide-neutral-100 text-sm">
              {credentials.map((c) => (
                <li key={c.providerName} className="flex items-center justify-between py-2">
                  <span>
                    <span className="font-medium">{c.providerName}</span>
                    <span className="ml-2 text-neutral-500">
                      stored {new Date(c.createdAt).toLocaleString()}
                    </span>
                  </span>
                  <button
                    onClick={() => removeCredential(c.providerName)}
                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Funding schedules */}
      <section className="space-y-3 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="font-medium">Funding schedules</h2>
        <p className="text-sm text-neutral-600">
          Define how often money is set aside for your buckets.
        </p>

        <form onSubmit={handleScheduleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            value={schedForm.name}
            onChange={(e) => setSchedForm({ ...schedForm, name: e.target.value })}
            placeholder="Schedule name"
            required
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <select
            value={schedForm.frequency}
            onChange={(e) => setSchedForm({ ...schedForm, frequency: e.target.value as typeof schedForm.frequency })}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Bi-weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="semimonthly_day_eom">Twice a month (day + end of month)</option>
            <option value="semimonthly_start_day">Twice a month (start + day)</option>
          </select>
          {(schedForm.frequency === 'semimonthly_day_eom' ||
            schedForm.frequency === 'semimonthly_start_day') && (
            <p className="text-xs text-neutral-500 sm:col-span-2">
              Pick any date below — we repeat on its day of month
              {schedForm.frequency === 'semimonthly_day_eom' ? ' plus end of month.' : ' plus the 1st.'}
            </p>
          )}
          <input
            type="date"
            value={schedForm.anchorDate}
            onChange={(e) => setSchedForm({ ...schedForm, anchorDate: e.target.value })}
            required
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <div className="flex gap-2 sm:col-span-2">
            {editingScheduleId ? (
              <span className="px-1 py-2 text-xs text-neutral-500">Changes save automatically.</span>
            ) : (
              <button
                type="submit"
                disabled={schedBusy || !schedForm.name.trim() || !activeBudgetId}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {schedBusy ? 'Saving…' : 'Add schedule'}
              </button>
            )}
            {editingScheduleId && (
              <button
                type="button"
                onClick={cancelScheduleEdit}
                className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        {schedError && <p className="text-sm text-red-600">{schedError}</p>}
        {schedSuccess && (
          <p className="text-sm text-green-700">
            {editingScheduleId ? 'Schedule saved.' : 'Schedule created.'}
          </p>
        )}

        {schedules.length > 0 && (
          <div className="border-t border-neutral-100 pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Existing schedules
            </h3>
            <ul className="divide-y divide-neutral-100 text-sm">
              {schedules.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2">
                  <div>
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-2 text-neutral-500">
                      {humanizeRule(s.recurrenceRule)}
                    </span>
                    {s.anchorDate && (
                      <span className="ml-2 text-neutral-400">
                        (anchor {s.anchorDate})
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => startEditSchedule(s)}
                      className="rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteSchedule(s)}
                      className="rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

function extractError(err: unknown): string {
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message)
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
        return parsed.error
      }
    } catch {
      // Not JSON — fall through to raw message
    }
    return err.message
  }
  return 'An unexpected error occurred.'
}
