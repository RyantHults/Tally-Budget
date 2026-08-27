import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type Account,
  type Bucket,
  type CreditCardConfig,
  type DiscoveredAccount,
} from '../lib/api'
import { useAuth } from '../stores/auth'
import { formatCents } from '@tally/core'
import { useDebouncedPatch } from '../hooks/useDebouncedPatch'

const TYPE_LABEL: Record<Account['type'], string> = {
  checking: 'Checking',
  savings: 'Savings',
  cd: 'CD',
  credit_card: 'Credit card',
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Returns a formatted date string if lastSeenAt is >3 days old, otherwise null. */
function staleBadge(lastSeenAt: string | null): string | null {
  if (!lastSeenAt) return null
  const daysSince = Math.floor(
    (Date.now() - new Date(lastSeenAt).getTime()) / (1000 * 60 * 60 * 24),
  )
  if (daysSince <= 3) return null
  return new Date(lastSeenAt).toLocaleDateString()
}

interface ConnectionGroup {
  key: string
  label: string
  connectionId: string | null
  accounts: Account[]
}

function groupByConnection(accounts: Account[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()
  for (const a of accounts) {
    const key = a.connectionName ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: key || 'Unlinked',
        connectionId: a.connectionId ?? null,
        accounts: [],
      }
      groups.set(key, group)
    }
    group.accounts.push(a)
  }
  return [...groups.values()]
}

export default function Accounts() {
  const activeBudgetId = useAuth((s) => s.activeBudgetId)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [error, setError] = useState<string | null>(null)
  const [syncQueued, setSyncQueued] = useState(false)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Discovered accounts manager (top "detected but not added" section)
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([])
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [editingConn, setEditingConn] = useState<{ key: string; value: string } | null>(null)

  // Phase 3: credit card config state
  const [creditConfigs, setCreditConfigs] = useState<CreditCardConfig[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [editingCardId, setEditingCardId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<'free_to_spend' | 'bucket'>('free_to_spend')
  const [editBucketId, setEditBucketId] = useState('')
  const [savingCardId, setSavingCardId] = useState<string | null>(null)
  const [cardError, setCardError] = useState<string | null>(null)

  // Inline rename state
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const accountAutosave = useDebouncedPatch<{
    endpoint: string
    fields: Record<string, unknown>
  }>(async ({ endpoint, fields }) => {
    await api.patch(endpoint, fields)
  }, { onError: () => setError('Failed to save account changes.') })

  const load = useCallback(async (budgetId: string) => {
    const [accts, configs, bkts] = await Promise.all([
      api.get<Account[]>(`/budgets/${budgetId}/accounts`),
      api.get<CreditCardConfig[]>(`/budgets/${budgetId}/credit-configs`),
      api.get<Bucket[]>(`/budgets/${budgetId}/buckets`),
    ])
    setAccounts(accts)
    setCreditConfigs(configs)
    setBuckets(bkts)
  }, [])

  const loadDiscovered = useCallback(async (budgetId: string) => {
    try {
      const disc = await api.get<DiscoveredAccount[]>(`/budgets/${budgetId}/discovered`)
      setDiscovered(disc)
    } catch {
      // Silently fail — discovered list is optional UI enhancement
    }
  }, [])

  useEffect(() => {
    if (!activeBudgetId) return
    load(activeBudgetId).catch(() => setError('Failed to load accounts.'))
    loadDiscovered(activeBudgetId)
  }, [activeBudgetId, load, loadDiscovered])

  useEffect(() => {
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current)
    }
  }, [])

  function forceSync() {
    if (!activeBudgetId || syncQueued) return
    setError(null)
    api
      .post('/integrations/simplefin/sync')
      .then(() => {
        setSyncQueued(true)
        syncTimer.current = setTimeout(() => {
          load(activeBudgetId)
            .then(() => loadDiscovered(activeBudgetId))
            .catch(() => setError('Failed to refresh accounts.'))
            .finally(() => setSyncQueued(false))
        }, 3000)
      })
      .catch(() => setError('Failed to queue sync.'))
  }

  async function linkDiscoveredAccount(providerAccountId: string) {
    if (!activeBudgetId) return
    setLinkingId(providerAccountId)
    setError(null)
    try {
      await api.post('/integrations/simplefin/link', {
        budgetId: activeBudgetId,
        providerAccountIds: [providerAccountId],
      })
      // Refresh both lists
      await load(activeBudgetId)
      await loadDiscovered(activeBudgetId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to link account.'
      setError(msg)
    } finally {
      setLinkingId(null)
    }
  }

  async function archiveAccount(account: Account) {
    if (!activeBudgetId) return
    setAccounts((prev) =>
      prev.map((a) => (a.id === account.id ? { ...a, status: 'archived' } : a)),
    )
    try {
      await api.patch(`/accounts/${account.id}`, { status: 'archived' })
    } catch {
      setAccounts((prev) =>
        prev.map((a) => (a.id === account.id ? { ...a, status: account.status } : a)),
      )
      setError('Failed to archive account.')
    }
  }

  async function unarchiveAccount(account: Account) {
    if (!activeBudgetId) return
    setAccounts((prev) =>
      prev.map((a) => (a.id === account.id ? { ...a, status: 'active' } : a)),
    )
    try {
      await api.patch(`/accounts/${account.id}`, { status: 'active' })
    } catch {
      setAccounts((prev) =>
        prev.map((a) => (a.id === account.id ? { ...a, status: account.status } : a)),
      )
      setError('Failed to unarchive account.')
    }
  }

  async function deleteAccount(account: Account) {
    if (!activeBudgetId) return
    if (
      !window.confirm(
        `Delete '${account.name}'? This permanently removes the account and ALL of its transactions. This cannot be undone.`,
      )
    ) {
      return
    }
    setAccounts((prev) => prev.filter((a) => a.id !== account.id))
    try {
      await api.del(`/accounts/${account.id}`)
    } catch {
      setAccounts((prev) => [...prev, account])
      setError('Failed to delete account.')
    }
  }

  async function changeType(account: Account, type: Account['type']) {
    if (type === account.type || !activeBudgetId) return
    // Optimistic update; revert on failure.
    setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, type } : a)))
    accountAutosave.schedule(`/accounts/${account.id}`, { endpoint: `/accounts/${account.id}`, fields: { type } })
  }

  function startRename(account: Account) {
    setEditingAccountId(account.id)
    setEditingName(account.name)
  }

  function cancelRename() {
    setEditingAccountId(null)
    setEditingName('')
  }

  function updateRename(account: Account, value: string) {
    setEditingName(value)
    const name = value.trim()
    if (name) {
      accountAutosave.schedule(`/accounts/${account.id}`, {
        endpoint: `/accounts/${account.id}`,
        fields: { name },
      })
    }
  }

  async function saveRename(account: Account) {
    setEditingAccountId(null)
    setEditingName('')
    void accountAutosave.flush(`/accounts/${account.id}`)
  }

  async function saveConnectionLabel(group: ConnectionGroup) {
    if (!editingConn || !activeBudgetId) return
    const connectionId = group.connectionId
    setEditingConn(null)
    if (!connectionId) return
    void accountAutosave.flush(`/connections/${connectionId}`)
  }

  function startEditCreditConfig(accountId: string) {
    const existing = creditConfigs.find((c) => c.accountId === accountId)
    setEditingCardId(accountId)
    setEditMode(existing?.mode ?? 'free_to_spend')
    setEditBucketId(existing?.payoffBucketId ?? (buckets[0]?.id ?? ''))
    setCardError(null)
  }

  function cancelEditCreditConfig() {
    setEditingCardId(null)
    setCardError(null)
  }

  async function saveCreditConfig(accountId: string) {
    if (!editBucketId) {
      setCardError('Select a payoff bucket.')
      return
    }
    setSavingCardId(accountId)
    setCardError(null)
    try {
      await api.put(`/accounts/${accountId}/credit-config`, {
        mode: editMode,
        payoffBucketId: editBucketId,
      })
      if (activeBudgetId) {
        const configs = await api.get<CreditCardConfig[]>(`/budgets/${activeBudgetId}/credit-configs`)
        setCreditConfigs(configs)
      }
      setEditingCardId(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save.'
      setCardError(msg.includes('400') ? 'Account must be a credit card.' : msg)
    } finally {
      setSavingCardId(null)
    }
  }

  async function removeCreditConfig(accountId: string) {
    if (!confirm('Remove payoff tracking for this card?')) return
    setSavingCardId(accountId)
    setCardError(null)
    try {
      await api.del(`/accounts/${accountId}/credit-config`)
      if (activeBudgetId) {
        const configs = await api.get<CreditCardConfig[]>(`/budgets/${activeBudgetId}/credit-configs`)
        setCreditConfigs(configs)
      }
      setEditingCardId(null)
    } catch {
      setCardError('Failed to remove config.')
    } finally {
      setSavingCardId(null)
    }
  }

  const groups = groupByConnection(accounts)

  // Unlinked detected accounts surface in their own section at the top.
  const unlinkedDiscovered = discovered
    .filter((d) => !d.linked)
    .sort((a, b) => a.name.localeCompare(b.name))

  // Sort institution groups alphabetically by label.
  groups.sort((a, b) => a.label.localeCompare(b.label))

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <button
          onClick={forceSync}
          disabled={syncQueued || !activeBudgetId || accounts.length === 0}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {syncQueued ? 'Sync queued…' : 'Force sync'}
        </button>
      </div>

      {syncQueued && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          Sync queued — refreshing shortly.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <p className="text-sm text-neutral-500">
        Link bank accounts from{' '}
        <a href="/settings" className="text-blue-600 underline">
          Settings → Bank connection
        </a>
        .
      </p>

      {unlinkedDiscovered.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-800">
            Detected but not added ({unlinkedDiscovered.length})
          </h2>
          <p className="mt-0.5 text-xs text-amber-700">
            These accounts were found in your connected banks but aren't part of this budget yet.
          </p>
          <ul className="mt-3 divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
            {unlinkedDiscovered.map((d) => (
              <li
                key={d.providerAccountId}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{d.name}</span>
                  <span className="text-xs text-neutral-500">{d.connectionName}</span>
                </div>
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-600">
                  {TYPE_LABEL[d.inferredType] ?? d.inferredType}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-neutral-600">
                  {formatCents(d.balanceCents)}
                </span>
                <button
                  onClick={() => linkDiscoveredAccount(d.providerAccountId)}
                  disabled={linkingId === d.providerAccountId}
                  className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {linkingId === d.providerAccountId ? 'Adding…' : '+ Add'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length === 0 && discovered.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No accounts yet — link a bank from Settings.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.key || '__ungrouped'} className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              {editingConn?.key === group.key ? (
                <input
                  autoFocus
                  value={editingConn.value}
                  onChange={(e) => {
                    const value = e.target.value
                    setEditingConn({ key: group.key, value })
                    if (group.connectionId && value.trim()) accountAutosave.schedule(`/connections/${group.connectionId}`, { endpoint: `/connections/${group.connectionId}`, fields: { orgName: value.trim() } })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveConnectionLabel(group)
                    if (e.key === 'Escape') { if (group.connectionId) accountAutosave.cancel(`/connections/${group.connectionId}`); setEditingConn(null) }
                  }}
                  onBlur={() => void saveConnectionLabel(group)}
                  placeholder="Institution name"
                  className="rounded border border-blue-400 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
                />
              ) : (
                <>
                  <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    {group.label || 'Linked accounts'}
                  </span>
                  {group.connectionId && (
                    <button
                      title="Rename institution"
                      onClick={() =>
                        setEditingConn({ key: group.key, value: group.label || '' })
                      }
                      className="text-[10px] text-neutral-300 hover:text-neutral-600"
                    >
                      ✎
                    </button>
                  )}
                </>
              )}
            </div>
            <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
              {group.accounts.map((a) => (
                <li key={a.id} className={`flex items-center justify-between gap-3 p-4 ${a.status === 'archived' ? 'opacity-60' : ''}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          title={`Connection ${a.connectionStatus ?? 'unknown'}`}
                          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                            a.connectionStatus === 'error'
                              ? 'bg-red-500'
                              : a.connectionStatus === 'active'
                                ? 'bg-green-500'
                                : 'bg-neutral-300'
                          }`}
                        />
                        {editingAccountId === a.id ? (
                          <input
                            autoFocus
                            value={editingName}
                            onChange={(e) => updateRename(a, e.target.value)}
                            onBlur={() => saveRename(a)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveRename(a)
                              if (e.key === 'Escape') { accountAutosave.cancel(`/accounts/${a.id}`); cancelRename() }
                            }}
                            className="rounded border border-blue-300 px-1.5 py-0.5 text-sm font-medium"
                          />
                        ) : (
                          <>
                            <span className="truncate font-medium">{a.name}</span>
                            <button
                              onClick={() => startRename(a)}
                              className="text-xs text-neutral-400 hover:text-neutral-600"
                              title="Rename account"
                            >
                              ✏️
                            </button>
                          </>
                        )}
                        <select
                          value={a.type}
                          onChange={(e) => changeType(a, e.target.value as Account['type'])}
                          title="Account type — credit cards are excluded from Free-to-Spend"
                          className="cursor-pointer rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-600 focus:outline-none"
                        >
                          {Object.entries(TYPE_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {a.status === 'archived' && (
                          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-600">
                            Archived
                          </span>
                        )}
                        {a.status === 'active' && staleBadge(a.lastSeenAt) && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                            Not seen since {staleBadge(a.lastSeenAt)}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-neutral-500">
                        Last synced {relativeTime(a.lastSyncAt)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={`text-sm tabular-nums ${
                          a.reportedBalanceCents < 0 ? 'text-red-600' : 'text-neutral-700'
                        }`}
                      >
                        {formatCents(a.reportedBalanceCents)}
                      </span>
                      {a.status === 'active' ? (
                        <button
                          onClick={() => archiveAccount(a)}
                          className="rounded border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                        >
                          Archive
                        </button>
                      ) : (
                        <button
                          onClick={() => unarchiveAccount(a)}
                          className="rounded border border-neutral-200 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
                        >
                          Unarchive
                        </button>
                      )}
                      <button
                        onClick={() => deleteAccount(a)}
                        className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {/* Phase 3: Credit cards section */}
      {creditConfigs.length > 0 && (
        <CreditCardsSection
          accounts={accounts}
          creditConfigs={creditConfigs}
          buckets={buckets}
          editingCardId={editingCardId}
          editMode={editMode}
          editBucketId={editBucketId}
          savingCardId={savingCardId}
          cardError={cardError}
          onStartEdit={startEditCreditConfig}
          onCancelEdit={cancelEditCreditConfig}
          onSave={saveCreditConfig}
          onRemove={removeCreditConfig}
          onModeChange={setEditMode}
          onBucketChange={setEditBucketId}
          editingAccountId={editingAccountId}
          editingName={editingName}
          onStartRename={startRename}
          onRenameChange={setEditingName}
          onRenameInput={updateRename}
          onSaveRename={saveRename}
          onCancelRename={cancelRename}
        />
      )}
    </div>
  )
}

/* ---------- Credit Cards sub-component ---------- */

interface CreditCardsSectionProps {
  accounts: Account[]
  creditConfigs: CreditCardConfig[]
  buckets: Bucket[]
  editingCardId: string | null
  editMode: 'free_to_spend' | 'bucket'
  editBucketId: string
  savingCardId: string | null
  cardError: string | null
  onStartEdit: (accountId: string) => void
  onCancelEdit: () => void
  onSave: (accountId: string) => void
  onRemove: (accountId: string) => void
  onModeChange: (mode: 'free_to_spend' | 'bucket') => void
  onBucketChange: (bucketId: string) => void
  editingAccountId: string | null
  editingName: string
  onStartRename: (account: Account) => void
  onRenameChange: (name: string) => void
  onRenameInput?: (account: Account, name: string) => void
  onSaveRename: (account: Account) => void
  onCancelRename: () => void
}

function CreditCardsSection({
  accounts,
  creditConfigs,
  buckets,
  editingCardId,
  editMode,
  editBucketId,
  savingCardId,
  cardError,
  onStartEdit,
  onCancelEdit,
  onSave,
  onRemove,
  onModeChange,
  onBucketChange,
  editingAccountId,
  editingName,
  onStartRename,
  onRenameChange,
  onRenameInput,
  onSaveRename,
  onCancelRename,
}: CreditCardsSectionProps) {
  const [collapsed, setCollapsed] = useState(false)
  const ccAccounts = accounts.filter((a) => a.type === 'credit_card')

  if (ccAccounts.length === 0) return null

  return (
    <section className="space-y-2">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-1 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-700"
      >
        <span>{collapsed ? '▸' : '▾'}</span>
        Credit cards ({ccAccounts.length})
      </button>
      {!collapsed && (
        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
          {ccAccounts.map((a) => {
            const config = creditConfigs.find((c) => c.accountId === a.id)
            const isEditing = editingCardId === a.id
            return (
              <li key={a.id} className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        title={`Connection ${a.connectionStatus ?? 'unknown'}`}
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          a.connectionStatus === 'error'
                            ? 'bg-red-500'
                            : a.connectionStatus === 'active'
                              ? 'bg-green-500'
                              : 'bg-neutral-300'
                        }`}
                      />
                      {editingAccountId === a.id ? (
                        <input
                          autoFocus
                          value={editingName}
                          onChange={(e) => onRenameInput?.(a, e.target.value) ?? onRenameChange(e.target.value)}
                          onBlur={() => onSaveRename(a)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') onSaveRename(a)
                            if (e.key === 'Escape') onCancelRename()
                          }}
                          className="rounded border border-blue-300 px-1.5 py-0.5 text-sm font-medium"
                        />
                      ) : (
                        <>
                          <span className="truncate font-medium">{a.name}</span>
                          <button
                            onClick={() => onStartRename(a)}
                            className="text-xs text-neutral-400 hover:text-neutral-600"
                            title="Rename account"
                          >
                            ✏️
                          </button>
                        </>
                      )}
                      <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-purple-700">
                        Credit card
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span
                      className={`text-sm tabular-nums ${
                        a.reportedBalanceCents < 0 ? 'text-red-600' : 'text-neutral-700'
                      }`}
                    >
                      {formatCents(a.reportedBalanceCents)}
                    </span>
                  </div>
                </div>

                {config && !isEditing && (
                  <div className="ml-4 flex items-center gap-4 text-sm text-neutral-600">
                    <span>
                      {config.mode === 'free_to_spend' ? 'Free-to-Spend' : 'Bucket'} mode
                    </span>
                    <span className="text-neutral-400">·</span>
                    <span>
                      Payoff: <span className="font-medium">{config.payoffBucketName}</span>
                    </span>
                    <span className="text-neutral-400">·</span>
                    <span className="tabular-nums">{formatCents(config.payoffBalanceCents)}</span>
                    <button
                      onClick={() => onStartEdit(a.id)}
                      className="ml-2 text-xs text-neutral-500 hover:text-neutral-700"
                    >
                      edit
                    </button>
                  </div>
                )}

                {!config && !isEditing && (
                  <button
                    onClick={() => onStartEdit(a.id)}
                    className="ml-4 rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    Set up payoff tracking
                  </button>
                )}

                {isEditing && (
                  <div className="ml-4 space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                    <div className="flex gap-3">
                      <label className="flex items-center gap-2 text-sm">
                        <span className="text-neutral-600">Mode:</span>
                        <select
                          value={editMode}
                          onChange={(e) =>
                            onModeChange(e.target.value as 'free_to_spend' | 'bucket')
                          }
                          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
                        >
                          <option value="free_to_spend">
                            Free-to-Spend: pre-fund every purchase
                          </option>
                          <option value="bucket">
                            Bucket: match purchases to buckets
                          </option>
                        </select>
                      </label>
                    </div>
                    <div className="flex gap-3">
                      <label className="flex items-center gap-2 text-sm">
                        <span className="text-neutral-600">Payoff bucket:</span>
                        <select
                          value={editBucketId}
                          onChange={(e) => onBucketChange(e.target.value)}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
                        >
                          {buckets.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {cardError && <p className="text-xs text-red-600">{cardError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => onSave(a.id)}
                        disabled={savingCardId === a.id}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingCardId === a.id ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={onCancelEdit}
                        disabled={savingCardId === a.id}
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      {config && (
                        <button
                          onClick={() => onRemove(a.id)}
                          disabled={savingCardId === a.id}
                          className="rounded-md px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
