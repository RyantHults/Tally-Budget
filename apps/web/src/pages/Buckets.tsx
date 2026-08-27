import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, type Bucket, type BucketDueFrequency, type BucketGroup, type CreditCardConfig, type FundingSchedule } from '../lib/api'
import { useAuth } from '../stores/auth'
import { formatCents } from '@tally/core'
import BucketDetailsModal from '../components/BucketDetailsModal'
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

const GROUP_DRAG_MIME = 'application/x-tally-bucket-group'

const GROUP_COLOR_PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
] as const

function chooseGroupColor(existingColors: readonly (string | null)[]): string {
  if (existingColors.length === 0) return GROUP_COLOR_PALETTE[0]

  const used = new Set(existingColors.filter((color): color is string => color != null).map((color) => color.toLowerCase()))
  const unused = GROUP_COLOR_PALETTE.filter((color) => !used.has(color))
  const candidates = unused.length > 0 ? unused : GROUP_COLOR_PALETTE
  const existingRgb = existingColors
    .map((color) => color ? color.match(/^#([\da-f]{6})$/i) : null)
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => {
      const value = parseInt(match[1]!, 16)
      return [value >> 16, (value >> 8) & 0xff, value & 0xff]
    })

  if (existingRgb.length === 0) return candidates[0]!

  return candidates.reduce((best, candidate) => {
    const candidateValue = parseInt(candidate.slice(1), 16)
    const candidateRgb = [candidateValue >> 16, (candidateValue >> 8) & 0xff, candidateValue & 0xff]
    const minDistance = Math.min(...existingRgb.map(([r, g, b]) =>
      Math.hypot(candidateRgb[0]! - r!, candidateRgb[1]! - g!, candidateRgb[2]! - b!),
    ))
    const bestValue = parseInt(best.slice(1), 16)
    const bestRgb = [bestValue >> 16, (bestValue >> 8) & 0xff, bestValue & 0xff]
    const bestDistance = Math.min(...existingRgb.map(([r, g, b]) =>
      Math.hypot(bestRgb[0]! - r!, bestRgb[1]! - g!, bestRgb[2]! - b!),
    ))
    return minDistance > bestDistance ? candidate : best
  })
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

interface BucketLocationState {
  fromTransactionId?: string
  name?: string
  targetAmountCents?: number
}

interface BucketGroupPreferences {
  expanded: Record<string, boolean>
}

export default function Buckets() {
  const activeBudgetId = useAuth((s) => s.activeBudgetId)
  const location = useLocation()
  const navigate = useNavigate()
  const locationState = (location.state ?? null) as BucketLocationState | null
  const fromTransactionId = locationState?.fromTransactionId ?? null
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [schedules, setSchedules] = useState<FundingSchedule[]>([])
  const [creditConfigs, setCreditConfigs] = useState<CreditCardConfig[]>([])
  const [groups, setGroups] = useState<BucketGroup[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(Boolean(fromTransactionId))
  const [form, setForm] = useState({
    name: locationState?.name ?? '',
    type: 'expense' as Bucket['type'],
    target: locationState?.targetAmountCents != null
      ? (locationState.targetAmountCents / 100).toFixed(2)
      : '',
    dueDate: '',
    targetDate: '',
    dueFrequency: 'monthly' as BucketDueFrequency,
    fundingMode: 'reach_target' as 'set_aside' | 'reach_target',
    scheduleId: '',
    bucketGroupId: null as string | null,
  })

  // Transfer state (per-bucket, keyed by bucket id)
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null)

  // Group editing state
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const editNameRef = useRef<HTMLInputElement>(null)
  const createNameRef = useRef<HTMLInputElement>(null)

  // Drop zone state: set of section keys being dragged over
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [groupDragId, setGroupDragId] = useState<string | null>(null)
  // Missing keys intentionally render expanded while preferences are loading.
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})
  const [groupDropTarget, setGroupDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)
  const debouncedGroupPatch = useDebouncedPatch<{ groupId: string; name?: string; color?: string }>(
    async ({ groupId, ...fields }) => {
      if (!activeBudgetId) return
      await api.patch(`/budgets/${activeBudgetId}/bucket-groups/${groupId}`, fields)
      await load(activeBudgetId)
    },
    { onError: () => setError('Failed to save group changes.') },
  )

  const load = useCallback(async (budgetId: string) => {
    const [b, s, c, g, preferences] = await Promise.all([
      api.get<Bucket[]>(`/budgets/${budgetId}/buckets`),
      api.get<FundingSchedule[]>(`/budgets/${budgetId}/funding-schedules`),
      api.get<CreditCardConfig[]>(`/budgets/${budgetId}/credit-configs`),
      api.get<BucketGroup[]>(`/budgets/${budgetId}/bucket-groups`),
      api.get<BucketGroupPreferences>(`/budgets/${budgetId}/bucket-group-preferences`)
        .catch(() => ({ expanded: {} })),
    ])
    setBuckets(b)
    setSchedules(s)
    setCreditConfigs(c)
    setGroups(g)
    setExpandedSections(preferences.expanded)
  }, [])

  useEffect(() => {
    if (activeBudgetId) {
      // Do not carry a previous budget's collapsed state into this request.
      setExpandedSections({})
      load(activeBudgetId).catch(() => setError('Failed to load buckets.'))
    }
  }, [activeBudgetId, load])

  useEffect(() => {
    if (!isCreateModalOpen) return
    createNameRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsCreateModalOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isCreateModalOpen])

  function openCreateBucket(groupId: string | null = null) {
    setForm({
      name: locationState?.name ?? '',
      type: 'expense',
      target: locationState?.targetAmountCents != null
        ? (locationState.targetAmountCents / 100).toFixed(2)
        : '',
      dueDate: '',
      targetDate: '',
      dueFrequency: 'monthly',
      fundingMode: 'reach_target',
      scheduleId: '',
      bucketGroupId: groupId,
    })
    setError(null)
    setIsCreateModalOpen(true)
  }

  function closeCreateBucket() {
    setIsCreateModalOpen(false)
    setForm({
      name: '',
      type: 'expense',
      target: '',
      dueDate: '',
      targetDate: '',
      dueFrequency: 'monthly',
      fundingMode: 'reach_target',
      scheduleId: '',
      bucketGroupId: null,
    })
  }

  async function createBucket(e: React.FormEvent) {
    e.preventDefault()
    if (!activeBudgetId) return
    let cents: number
    try {
      cents = Math.round(parseFloat(form.target) * 100)
      if (!Number.isFinite(cents) || cents < 0) throw new Error()
    } catch {
      setError('Enter a valid non-negative target amount.')
      return
    }
    if (form.type === 'expense') {
      if (!form.dueDate || !form.dueFrequency) {
        setError('Choose a due date and frequency for this expense.')
        return
      }
    } else if (!form.targetDate) {
      setError(`${TYPE_LABEL[form.type]} buckets require a due date.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await api.post<Bucket>(`/budgets/${activeBudgetId}/buckets`, {
        name: form.name,
        type: form.type,
        targetAmountCents: cents,
        dueDay: null,
        dueDate: form.type === 'expense' ? form.dueDate : null,
        dueFrequency: form.type === 'expense' ? form.dueFrequency : null,
        targetDate: form.type === 'expense' ? null : form.targetDate,
        fundingMode: form.fundingMode,
        fundingScheduleId: form.scheduleId || null,
        bucketGroupId: form.bucketGroupId,
      })
      // Auto-assign transaction if navigated from Transactions page
      if (fromTransactionId) {
        try {
          await api.patch(`/transactions/${fromTransactionId}`, { bucketId: created.id })
        } catch {
          // Non-fatal — bucket was created successfully
        }
        // Clear navigation state so refresh doesn't re-prefill
        navigate('/buckets', { replace: true, state: null })
      }
      await load(activeBudgetId)
      closeCreateBucket()
    } catch {
      setError('Failed to create bucket.')
    } finally {
      setBusy(false)
    }
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault()
    const name = newGroupName.trim()
    if (!name || !activeBudgetId) return
    try {
      const color = chooseGroupColor(groups.map((group) => group.color))
      await api.post(`/budgets/${activeBudgetId}/bucket-groups`, { name, color })
      setNewGroupName('')
      await load(activeBudgetId)
    } catch {
      setError('Failed to create group.')
    }
  }

  function saveGroupName(groupId: string) {
    if (!activeBudgetId) return
    const name = editingGroupName.trim()
    if (!name) { setEditingGroupId(null); return }
    debouncedGroupPatch.schedule(groupId, { groupId, name })
    setEditingGroupId(null)
  }

  function saveGroupColor(groupId: string, color: string) {
    if (!activeBudgetId) return
    debouncedGroupPatch.schedule(groupId, { groupId, color })
  }

  async function deleteGroup(groupId: string) {
    if (!activeBudgetId) return
    const group = groups.find((candidate) => candidate.id === groupId)
    const groupName = group?.name ?? 'This group'
    if (!window.confirm(`Delete “${groupName}” and move its buckets to Unassigned?`)) return
    try {
      await api.del(`/budgets/${activeBudgetId}/bucket-groups/${groupId}`)
      await load(activeBudgetId)
    } catch {
      setError('Failed to delete group.')
    }
  }

  async function assignBucketToGroup(bucketId: string, groupId: string | null) {
    if (!activeBudgetId) return
    const bucket = buckets.find((b) => b.id === bucketId)
    if (!bucket) return
    try {
      await api.patch(`/budgets/${activeBudgetId}/buckets/${bucketId}`, {
        bucketGroupId: groupId,
        version: bucket.version,
      })
      await load(activeBudgetId)
    } catch {
      setError('Failed to move bucket.')
    }
  }

  const payoffBucketIds = new Set(creditConfigs.map((c) => c.payoffBucketId))
  const selectedBucket = buckets.find((b) => b.id === selectedBucketId) ?? null

  async function reorderGroups(sourceId: string, targetId: string, position: 'before' | 'after') {
    if (!activeBudgetId || sourceId === targetId) return

    const sourceIndex = groups.findIndex((group) => group.id === sourceId)
    const targetIndex = groups.findIndex((group) => group.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return

    const nextGroups = groups.filter((group) => group.id !== sourceId)
    const nextTargetIndex = nextGroups.findIndex((group) => group.id === targetId)
    nextGroups.splice(nextTargetIndex + (position === 'after' ? 1 : 0), 0, groups[sourceIndex]!)
    const orderedIds = nextGroups.map((group) => group.id)

    // Keep the new order on screen while the server persists it.
    setGroups(nextGroups)
    setGroupDropTarget(null)
    try {
      await api.post(`/budgets/${activeBudgetId}/bucket-groups/reorder`, { groupIds: orderedIds })
    } catch {
      try {
        await load(activeBudgetId)
      } catch {
        // Keep the original error treatment even if refreshing also fails.
      }
      setError('Failed to reorder groups.')
    }
  }

  function isGroupDrag(e: React.DragEvent) {
    return Array.from(e.dataTransfer.types).includes(GROUP_DRAG_MIME)
  }

  function handleGroupDragStart(e: React.DragEvent, groupId: string) {
    e.stopPropagation()
    e.dataTransfer.setData(GROUP_DRAG_MIME, groupId)
    e.dataTransfer.effectAllowed = 'move'
    setGroupDragId(groupId)
  }

  function handleGroupDragEnd() {
    setGroupDragId(null)
    setGroupDropTarget(null)
  }

  function handleGroupDragOver(e: React.DragEvent, targetId: string) {
    if (!isGroupDrag(e) || groupDragId === targetId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const bounds = e.currentTarget.getBoundingClientRect()
    setGroupDropTarget({ id: targetId, position: e.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' })
  }

  function handleGroupDrop(e: React.DragEvent, targetId: string) {
    if (!isGroupDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    const sourceId = e.dataTransfer.getData(GROUP_DRAG_MIME)
    const position = groupDropTarget?.id === targetId ? groupDropTarget.position : 'before'
    setGroupDragId(null)
    setGroupDropTarget(null)
    void reorderGroups(sourceId, targetId, position)
  }

  // Sections follow the order supplied by the server/state. Unassigned is always last.
  const groupSections: { key: string; label: string; color: string | null; items: Bucket[] }[] = [
    ...groups.map((g) => ({
        key: g.id,
        label: g.name,
        color: g.color,
        items: buckets.filter((b) => b.bucketGroupId === g.id),
      })),
    {
      key: '__ungrouped',
      label: 'Unassigned',
      color: null,
      items: buckets.filter(
        (b) => !b.bucketGroupId || !groups.some((g) => g.id === b.bucketGroupId),
      ),
    },
  ]

  function handleDragStart(e: React.DragEvent, bucketId: string) {
    e.dataTransfer.setData('application/json', JSON.stringify({ bucketId }))
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDrop(e: React.DragEvent, sectionKey: string) {
    // Group drags are handled by the section, not by the bucket assignment zone.
    if (isGroupDrag(e)) return
    e.preventDefault()
    setDragOverKey(null)
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'))
      if (data.bucketId) {
        const groupId = sectionKey === '__ungrouped' ? null : sectionKey
        assignBucketToGroup(data.bucketId, groupId)
      }
    } catch { /* ignore malformed data */ }
  }

  function toggleSection(sectionKey: string) {
    const expanded = !(expandedSections[sectionKey] ?? true)
    setExpandedSections((current) => ({ ...current, [sectionKey]: expanded }))
    if (!activeBudgetId) return

    void api.put(`/budgets/${activeBudgetId}/bucket-group-preferences`, {
      sectionKey,
      expanded,
    }).catch(async () => {
      try {
        await load(activeBudgetId)
      } catch {
        // Keep the page usable even if refreshing the authoritative state fails.
      }
      setError('Failed to update group expansion.')
    })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Buckets</h1>
        <button
          type="button"
          onClick={() => openCreateBucket()}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Add new bucket
        </button>
      </div>

      {fromTransactionId && (
        <div className="flex items-center justify-between rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          <span>
            Creating a bucket from a transaction — it will be auto-assigned after creation.
          </span>
          <button
            onClick={() => navigate('/buckets', { replace: true, state: null })}
            className="ml-3 text-xs text-green-600 underline hover:text-green-800"
          >
            Dismiss
          </button>
        </div>
      )}

      <form onSubmit={createGroup} className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Groups
        </span>
        <input
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder="New group name"
          className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs sm:flex-none"
        />
        <button
          type="submit"
          disabled={!newGroupName.trim()}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
        >
          + Add group
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {groupSections.map((section) => {
        const isUngrouped = section.key === '__ungrouped'
        const isEditing = editingGroupId === section.key
        const isDragOver = dragOverKey === section.key
        const insertion = !isUngrouped && groupDropTarget?.id === section.key
        const isExpanded = expandedSections[section.key] ?? true
        const currentTotal = section.items.reduce((sum, bucket) => sum + bucket.currentBalanceCents, 0)
        const targetTotal = section.items.reduce((sum, bucket) => sum + bucket.targetAmountCents, 0)

        return (
          <section
            key={section.key}
            className="relative space-y-2"
            onDragOver={!isUngrouped ? (e) => handleGroupDragOver(e, section.key) : undefined}
            onDragLeave={(e) => {
              if (groupDropTarget?.id === section.key && !e.currentTarget.contains(e.relatedTarget as Node)) {
                setGroupDropTarget(null)
              }
            }}
            onDrop={!isUngrouped ? (e) => handleGroupDrop(e, section.key) : undefined}
          >
            {insertion && groupDropTarget?.position === 'before' && (
              <div className="pointer-events-none absolute -top-2 left-1 right-1 z-10 h-0.5 rounded-full bg-blue-500" aria-hidden="true" />
            )}
            <div className="relative flex items-center gap-1.5 px-1 pl-7">
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${section.label} group`}
                onClick={() => toggleSection(section.key)}
                className="absolute left-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <svg
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="m6 3 5 5-5 5" />
                </svg>
              </button>

              {!isUngrouped && (
                <button
                  type="button"
                  draggable
                  aria-label={`Reorder ${section.label} group`}
                  title="Drag to reorder group"
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => handleGroupDragStart(e, section.key)}
                  onDragEnd={handleGroupDragEnd}
                  className="cursor-grab rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 active:cursor-grabbing"
                >
                  <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="5" cy="4" r="1.2" /><circle cx="11" cy="4" r="1.2" />
                    <circle cx="5" cy="8" r="1.2" /><circle cx="11" cy="8" r="1.2" />
                    <circle cx="5" cy="12" r="1.2" /><circle cx="11" cy="12" r="1.2" />
                  </svg>
                </button>
              )}

              {/* Color dot — clickable to change color (not for ungrouped) */}
              {!isUngrouped && section.color && (
                <label className="relative inline-block">
                  <span
                    className="inline-block h-2.5 w-2.5 cursor-pointer rounded-full transition-transform hover:scale-125"
                    style={{ backgroundColor: section.color }}
                    title="Change group color"
                  />
                  <input
                    type="color"
                    value={section.color}
                    onChange={(e) => saveGroupColor(section.key, e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              )}

              {/* Group name — editable */}
              {isEditing ? (
                <input
                  ref={editNameRef}
                  value={editingGroupName}
                  onChange={(e) => {
                    setEditingGroupName(e.target.value)
                    if (e.target.value.trim()) debouncedGroupPatch.schedule(section.key, { groupId: section.key, name: e.target.value.trim() })
                  }}
                  onBlur={() => setEditingGroupId(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveGroupName(section.key)
                    if (e.key === 'Escape') setEditingGroupId(null)
                  }}
                  autoFocus
                  className="w-40 rounded border border-blue-300 px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-neutral-700 outline-none"
                />
              ) : (
                <h2
                  className={`text-xs font-semibold uppercase tracking-wide ${isUngrouped ? 'text-neutral-400' : 'cursor-pointer text-neutral-500 hover:text-neutral-700'}`}
                  onClick={() => {
                    if (isUngrouped) return
                    setEditingGroupId(section.key)
                    setEditingGroupName(section.label)
                  }}
                  title={isUngrouped ? undefined : 'Click to rename'}
                >
                  {section.label}
                </h2>
              )}

              {/* Count badge */}
              <span className="text-xs text-neutral-400">
                ({section.items.length})
              </span>

              <span className="whitespace-nowrap text-xs text-neutral-400">
                {formatCents(currentTotal)} of {formatCents(targetTotal)}
              </span>

              {isExpanded && section.items.length > 0 && (
                <button
                  type="button"
                  onClick={() => openCreateBucket(isUngrouped ? null : section.key)}
                  className="ml-auto whitespace-nowrap rounded-md border border-dashed border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs font-medium text-neutral-600 hover:border-neutral-400 hover:bg-neutral-50"
                >
                  + Add bucket here
                </button>
              )}

              {/* Delete button — not for ungrouped */}
              {!isUngrouped && (
                <button
                  onClick={() => deleteGroup(section.key)}
                  className="rounded border border-red-200 px-1.5 py-0.5 text-[11px] font-medium text-red-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                  title="Delete group"
                >
                  Delete
                </button>
              )}
            </div>

            {insertion && groupDropTarget?.position === 'after' && (
              <div className="pointer-events-none absolute -bottom-2 left-1 right-1 z-10 h-0.5 rounded-full bg-blue-500" aria-hidden="true" />
            )}

            {isExpanded && <>
              {/* Bucket grid — drop zone */}
              <div
                onDragOver={(e) => {
                  if (isGroupDrag(e)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverKey(section.key)
                }}
                onDragLeave={() => { if (dragOverKey === section.key) setDragOverKey(null) }}
                onDrop={(e) => handleDrop(e, section.key)}
                className={`grid grid-cols-1 gap-3 rounded-lg p-1 transition-colors sm:grid-cols-2 ${
                  isDragOver
                    ? 'bg-blue-50 ring-2 ring-inset ring-blue-200'
                    : section.items.length === 0
                      ? 'border border-dashed border-neutral-200 bg-neutral-50/50'
                      : ''
                }`}
              >
                {section.items.length === 0 && (
                  <div className="col-span-full py-4 text-center text-xs text-neutral-400">
                    {isUngrouped ? 'All buckets assigned' : 'Drop a bucket here'}
                  </div>
                )}
                {section.items.map((b) => {
                const pct =
                  b.targetAmountCents > 0
                    ? Math.min(100, Math.max(0, (b.currentBalanceCents / b.targetAmountCents) * 100))
                    : 0
                const nearTarget = pct >= 90

                return (
                  <div
                    key={b.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, b.id)}
                    onClick={() => setSelectedBucketId(b.id)}
                    className={`cursor-pointer space-y-2 rounded-lg border bg-white p-4 shadow-sm transition-shadow hover:shadow-md ${
                      !isUngrouped && section.color
                        ? 'border-l-4 border border-neutral-200'
                        : 'border-neutral-200'
                    }`}
                    style={!isUngrouped && section.color ? { borderLeftColor: section.color } : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">{b.name}</span>
                        {payoffBucketIds.has(b.id) && (
                          <span className="ml-2 rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700">
                            CC payoff
                          </span>
                        )}
                        <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-600">
                          {TYPE_LABEL[b.type]}
                        </span>
                        {b.type === 'expense' && b.dueDate && b.dueFrequency === 'monthly' ? (
                          <span className="ml-2 text-xs text-neutral-500">
                            due monthly on the {ordinal(String(Number(b.dueDate.slice(8, 10))))}
                          </span>
                        ) : b.type === 'expense' && b.dueDate && b.dueFrequency ? (
                          <span className="ml-2 text-xs text-neutral-500">due {DUE_FREQUENCY_LABEL[b.dueFrequency].toLowerCase()}</span>
                        ) : b.type === 'expense' && b.dueDay != null ? (
                          <span className="ml-2 text-xs text-neutral-500">
                            due monthly on the {ordinal(String(b.dueDay))}
                          </span>
                        ) : b.targetDate ? (
                          <span className="ml-2 text-xs text-neutral-500">by {b.targetDate}</span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right text-sm text-neutral-700">
                          <span className="tabular-nums">{formatCents(b.currentBalanceCents)}</span>
                          <span className="text-neutral-400"> / </span>
                          <span className="tabular-nums">{formatCents(b.targetAmountCents)}</span>
                          {b.fundingMode && (
                            <span className="ml-2 text-xs text-neutral-400">
                              {b.fundingMode === 'set_aside' ? 'set-aside' : 'reach-target'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Progress bar */}
                    {b.targetAmountCents > 0 && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                        <div
                          className={`h-full rounded-full transition-all ${
                            nearTarget ? 'bg-amber-400' : 'bg-green-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )
                })}
              </div>

              {section.items.length === 0 && (
                <button
                  type="button"
                  onClick={() => openCreateBucket(isUngrouped ? null : section.key)}
                  className="mx-auto block w-full rounded-md border border-dashed border-neutral-300 bg-transparent px-2 py-1.5 text-center text-xs font-medium text-neutral-600 hover:border-neutral-400 hover:bg-neutral-50"
                >
                  + Add bucket here 
                </button>
              )}
            </>}
          </section>
        )
      })}

      {isCreateModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-neutral-900/40 p-4"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCreateBucket()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-bucket-title"
            className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white p-5 shadow-xl"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="create-bucket-title" className="text-lg font-semibold text-neutral-800">
                  Add new bucket
                </h2>
                <p className="mt-1 text-xs text-neutral-500">Give this bucket a home and a target.</p>
              </div>
              <button
                type="button"
                onClick={closeCreateBucket}
                className="rounded-md p-1 text-lg leading-none text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                aria-label="Close add bucket dialog"
              >
                ×
              </button>
            </div>

            {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

            <form onSubmit={createBucket} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-neutral-600 sm:col-span-2">
                Name
                <input
                  ref={createNameRef}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-neutral-600">
                Bucket type
                <select
                  value={form.type}
                  onChange={(e) => {
                    const type = e.target.value as Bucket['type']
                    setForm({
                      ...form,
                      type,
                      dueDate: type === 'expense' ? form.dueDate : '',
                      dueFrequency: type === 'expense' ? form.dueFrequency : 'monthly',
                      targetDate: type === 'expense' ? '' : form.targetDate,
                    })
                  }}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                >
                  <option value="expense">Expense</option>
                  <option value="goal">Goal</option>
                  <option value="vault">Vault</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium text-neutral-600">
                Bucket group
                <select
                  value={form.bucketGroupId ?? ''}
                  onChange={(e) => setForm({ ...form, bucketGroupId: e.target.value || null })}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                >
                  <option value="">Unassigned</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium text-neutral-600">
                Target amount ($)
                <input
                  inputMode="decimal"
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                  required
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </label>
              {form.type === 'expense' ? (
                <>
                  <label className="space-y-1 text-xs font-medium text-neutral-600">
                    Due date
                    <input
                      type="date"
                      required
                      value={form.dueDate}
                      onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                      className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                    />
                    <span className="block font-normal text-neutral-400">Bucket will be funded every {DUE_FREQUENCY_LABEL[form.dueFrequency].toLowerCase()} by the chosen date.</span>
                  </label>
                  <label className="space-y-1 text-xs font-medium text-neutral-600">
                    Frequency
                    <select
                      required
                      value={form.dueFrequency}
                      onChange={(e) => setForm({ ...form, dueFrequency: e.target.value as BucketDueFrequency })}
                      className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                    >
                      {(Object.keys(DUE_FREQUENCY_LABEL) as BucketDueFrequency[]).map((frequency) => (
                        <option key={frequency} value={frequency}>{DUE_FREQUENCY_LABEL[frequency]}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <label className="space-y-1 text-xs font-medium text-neutral-600">
                  Due date
                  <input
                    required
                    type="date"
                    value={form.targetDate}
                    onChange={(e) => setForm({ ...form, targetDate: e.target.value })}
                    className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                  />
                </label>
              )}
              <label className="space-y-1 text-xs font-medium text-neutral-600 sm:col-span-2">
                Funding option
                <select
                  value={form.fundingMode}
                  onChange={(e) => setForm({ ...form, fundingMode: e.target.value as 'set_aside' | 'reach_target' })}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                >
                  <option value="set_aside">Set aside each period</option>
                  <option value="reach_target">Reach target, then pause</option>
                </select>
                <span className="block font-normal text-neutral-400">{FUNDING_MODE_DESCRIPTION[form.fundingMode]}</span>
              </label>
              <label className="space-y-1 text-xs font-medium text-neutral-600 sm:col-span-2">
                Funding schedule
                <select
                  value={form.scheduleId}
                  onChange={(e) => setForm({ ...form, scheduleId: e.target.value })}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-800"
                >
                  <option value="">No schedule yet</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({humanizeRule(s.recurrenceRule)})</option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2 pt-2 sm:col-span-2">
                <button
                  type="button"
                  onClick={closeCreateBucket}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !activeBudgetId}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? 'Adding…' : 'Add bucket'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedBucket && activeBudgetId && (
        <BucketDetailsModal
          key={selectedBucket.id}
          groups={groups}
          bucket={selectedBucket}
          schedules={schedules}
          allBuckets={buckets}
          budgetId={activeBudgetId}
          onClose={() => setSelectedBucketId(null)}
          onSaved={(updated) =>
            setBuckets((prev) =>
              prev.map((b) =>
                b.id === updated.id
                  ? {
                      ...b,
                      ...updated,
                      currentBalanceCents:
                        updated.currentBalanceCents ?? b.currentBalanceCents,
                    }
                  : b,
              ),
            )
          }
          onDeleted={(id) => {
            setBuckets((prev) => prev.filter((b) => b.id !== id))
            setSelectedBucketId(null)
          }}
          onBalancesChanged={() => load(activeBudgetId)}
        />
      )}
    </div>
  )
}
