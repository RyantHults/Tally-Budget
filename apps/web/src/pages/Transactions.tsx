import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Account, type Bucket, type Category, type Transaction } from '../lib/api'
import { useAuth } from '../stores/auth'
import { formatCents } from '@tally/core'

const PAGE_SIZE = 50

const STATUS_LABEL: Record<Transaction['status'], string> = {
  pending: 'Pending',
  posted: 'Posted',
  superseded: 'Superseded',
}

/** Strip REF segments and collapse whitespace to produce a clean bucket name. */
function cleanBucketName(description: string): string {
  return description.replace(/\s*\bREF\b.*$/i, '').replace(/\s{2,}/g, ' ').trim()
}

function Amount({ cents }: { cents: number }) {
  return (
    <span
      className={`tabular-nums ${cents < 0 ? 'text-red-600' : cents > 0 ? 'text-green-600' : 'text-neutral-700'}`}
    >
      {formatCents(cents)}
    </span>
  )
}

function StatusChip({ status }: { status: Transaction['status'] }) {
  const cls =
    status === 'pending'
      ? 'bg-amber-100 text-amber-800'
      : status === 'posted'
        ? 'bg-neutral-100 text-neutral-600'
        : 'bg-neutral-100 text-neutral-400'
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs uppercase tracking-wide ${cls}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

export default function Transactions() {
  const activeBudgetId = useAuth((s) => s.activeBudgetId)
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [unknown, setUnknown] = useState<Transaction[]>([])
  const [accountIdFilter, setAccountIdFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(true)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Mark-as-transfer UI state: txn id -> whether picker is open
  const [transferPickerId, setTransferPickerId] = useState<string | null>(null)

  // Undo toast state for category assignments
  const [undoInfo, setUndoInfo] = useState<{
    txnId: string
    oldCategoryId: string | null
    recategorizedIds: string[]
    categoryId: string
    txnName: string
  } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dismissUndo = useCallback(() => {
    clearTimeout(undoTimer.current)
    setUndoInfo(null)
  }, [])

  const load = useCallback(
    async (budgetId: string) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' })
      if (accountIdFilter) params.set('accountId', accountIdFilter)
      if (statusFilter) params.set('status', statusFilter)
      const [txns, accts, bkts, cats, unk] = await Promise.all([
        api.get<Transaction[]>(`/budgets/${budgetId}/transactions?${params}`),
        api.get<Account[]>(`/budgets/${budgetId}/accounts`),
        api.get<Bucket[]>(`/budgets/${budgetId}/buckets`),
        api.get<Category[]>(`/budgets/${budgetId}/categories`),
        api.get<Transaction[]>(`/budgets/${budgetId}/transactions/unknown`),
      ])
      setTransactions(txns)
      setAccounts(accts)
      setBuckets(bkts)
      setCategories(cats)
      setUnknown(unk)
    },
    [accountIdFilter, statusFilter],
  )

  useEffect(() => {
    if (!activeBudgetId) return
    load(activeBudgetId).catch(() => setError('Failed to load transactions.'))
  }, [activeBudgetId, load])

  async function loadMore() {
    if (!activeBudgetId) return
    setLoadingMore(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(transactions.length),
      })
      if (accountIdFilter) params.set('accountId', accountIdFilter)
      if (statusFilter) params.set('status', statusFilter)
      const more = await api.get<Transaction[]>(
        `/budgets/${activeBudgetId}/transactions?${params}`,
      )
      setTransactions((prev) => [...prev, ...more])
    } catch {
      setError('Failed to load more transactions.')
    } finally {
      setLoadingMore(false)
    }
  }

  async function assignCategory(txn: Transaction, categoryId: string) {
    if (!categoryId || !activeBudgetId) return
    const oldCategoryId = txn.categoryId
    // Snapshot unknown IDs before so we can detect which ones got recategorized.
    let prevUnknownIds: string[] = []
    setUnknown((prev) => {
      prevUnknownIds = prev.map((t) => t.id)
      return prev.filter((t) => t.id !== txn.id)
    })
    try {
      const result = await api.patch<Transaction & { recategorized?: number }>(
        `/transactions/${txn.id}`,
        { categoryId },
      )
      setTransactions((prev) =>
        prev.map((t) => (t.id === txn.id ? { ...t, categoryId } : t)),
      )
      // The server retroactively recategorizes similar uncategorized transactions.
      // Re-fetch the unknown list and figure out which ones were recategorized
      // so the undo handler can revert them.
      let recategorizedIds: string[] = []
      const updatedUnknown = await api.get<Transaction[]>(
        `/budgets/${activeBudgetId}/transactions/unknown`,
      )
      if (result.recategorized && result.recategorized > 0) {
        const newUnknownIds = new Set(updatedUnknown.map((t) => t.id))
        recategorizedIds = prevUnknownIds.filter((id) => id !== txn.id && !newUnknownIds.has(id))
      }
      setUnknown(updatedUnknown)

      // Show undo toast for 8 seconds.
      clearTimeout(undoTimer.current)
      setUndoInfo({
        txnId: txn.id,
        oldCategoryId,
        recategorizedIds,
        categoryId,
        txnName: txn.merchantDescription,
      })
      undoTimer.current = setTimeout(dismissUndo, 8000)
    } catch {
      setUnknown((prev) =>
        [...prev, txn].sort(
          (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime(),
        ),
      )
      setReviewError('Failed to assign category.')
    }
  }

  async function undoCategory() {
    if (!undoInfo || !activeBudgetId) return
    const { txnId, oldCategoryId, recategorizedIds, categoryId } = undoInfo
    dismissUndo()
    // Revert the main transaction.
    await api.patch(`/transactions/${txnId}`, { categoryId: oldCategoryId })
    setTransactions((prev) =>
      prev.map((t) => (t.id === txnId ? { ...t, categoryId: oldCategoryId } : t)),
    )
    // Revert any retroactively recategorized transactions.
    if (recategorizedIds.length > 0) {
      await Promise.all(
        recategorizedIds.map((id) => api.patch(`/transactions/${id}`, { categoryId: null })),
      )
      setTransactions((prev) =>
        prev.map((t) =>
          recategorizedIds.includes(t.id) ? { ...t, categoryId: null } : t,
        ),
      )
    }
    // Refresh unknown list.
    const updatedUnknown = await api.get<Transaction[]>(
      `/budgets/${activeBudgetId}/transactions/unknown`,
    )
    setUnknown(updatedUnknown)
  }

  // Clean up timer on unmount.
  useEffect(() => () => clearTimeout(undoTimer.current), [])

  async function assignBucket(txn: Transaction, bucketId: string) {
    if (!activeBudgetId) return
    const value = bucketId === '' ? null : bucketId
    // Optimistic update
    setTransactions((prev) =>
      prev.map((t) => (t.id === txn.id ? { ...t, bucketId: value } : t)),
    )
    try {
      await api.patch(`/transactions/${txn.id}`, { bucketId: value })
    } catch {
      // Revert
      setTransactions((prev) =>
        prev.map((t) => (t.id === txn.id ? { ...t, bucketId: txn.bucketId } : t)),
      )
      setError('Failed to assign bucket.')
    }
  }

  async function markAsTransfer(txn: Transaction, otherId: string) {
    if (!activeBudgetId) return
    try {
      await api.post(`/transactions/${txn.id}/mark-transfer`, { otherTransactionId: otherId })
      // Reload to get updated transferLinkId on both sides
      setTransferPickerId(null)
      await load(activeBudgetId)
    } catch {
      setError('Failed to mark as transfer.')
    }
  }

  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? null
  const hasFilters = Boolean(accountIdFilter || statusFilter)

  const pending = transactions.filter((t) => t.status === 'pending')
  const posted = transactions.filter((t) => t.status !== 'pending')

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Transactions</h1>

      <div className="flex gap-3">
        <select
          value={accountIdFilter}
          onChange={(e) => setAccountIdFilter(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-40 rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          <option value="posted">Posted</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      {pending.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-white">
          <button
            onClick={() => setPendingOpen((o) => !o)}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <span className="text-sm font-medium text-amber-800">
              Pending transactions ({pending.length})
            </span>
            <span className="text-xs text-neutral-500">{pendingOpen ? 'Hide ▲' : 'Show ▼'}</span>
          </button>
          {pendingOpen && (
            <div className="border-t border-neutral-100">
              <ul className="divide-y divide-neutral-100">
                {pending.map((t) => {
                  const category = t.categoryId ? categoryName(t.categoryId) : null
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {t.merchantDescription}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {t.accountName} · {new Date(t.postedAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Amount cents={t.amountCents} />
                        <StatusChip status={t.status} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {unknown.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-white">
          <button
            onClick={() => setReviewOpen((o) => !o)}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <span className="text-sm font-medium text-amber-800">
              Review unknown categories ({unknown.length})
            </span>
            <span className="text-xs text-neutral-500">{reviewOpen ? 'Hide ▲' : 'Show ▼'}</span>
          </button>
          {reviewOpen && (
            <div className="border-t border-neutral-100">
              {reviewError && <p className="px-4 pt-3 text-sm text-red-600">{reviewError}</p>}
              <ul className="divide-y divide-neutral-100">
                {unknown.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {t.merchantDescription}
                      </span>
                      <span className="text-xs text-neutral-500">
                        {t.accountName} · {new Date(t.postedAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Amount cents={t.amountCents} />
                      <select
                        value=""
                        onChange={(e) => assignCategory(t, e.target.value)}
                        className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                      >
                        <option value="">Assign category…</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
        {posted.length === 0 && (
          <li className="p-5 text-sm text-neutral-500">
            {hasFilters ? 'No transactions match these filters.' : 'No posted transactions yet.'}
          </li>
        )}
        {posted.map((t) => {
          const category = t.categoryId ? categoryName(t.categoryId) : null
          const isTransfer = t.transferLinkId != null
          const pickerOpen = transferPickerId === t.id
          // Find candidate matching transactions for transfer pairing:
          // same account, posted, same abs(amount), opposite sign, no existing link
          const candidates = !isTransfer
            ? transactions.filter(
                (c) =>
                  c.id !== t.id &&
                  c.accountId === t.accountId &&
                  c.status === 'posted' &&
                  c.transferLinkId == null &&
                  c.amountCents === -t.amountCents,
              )
            : []

          return (
            <li key={t.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="block truncate font-medium">{t.merchantDescription}</span>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                    <span className="truncate">{t.accountName}</span>
                    <span>{new Date(t.postedAt).toLocaleDateString()}</span>
                    <StatusChip status={t.status} />
                    {isTransfer && (
                      <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
                        Transfer
                      </span>
                    )}
                    {category ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                        {category}
                      </span>
                    ) : (
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
                        Unknown
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Amount cents={isTransfer ? 0 : t.amountCents} />
                  {/* Bucket assignment for posted transactions */}
                  {t.status === 'posted' && !isTransfer && (
                    <select
                      value={t.bucketId ?? ''}
                      onChange={(e) => assignBucket(t, e.target.value)}
                      className="w-32 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                    >
                      <option value="">Free-to-Spend</option>
                      {buckets.map((bk) => (
                        <option key={bk.id} value={bk.id}>
                          {bk.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* Mark-as-transfer for posted, non-linked txns with a match */}
                  {t.status === 'posted' && !isTransfer && candidates.length > 0 && (
                    <button
                      onClick={() => setTransferPickerId(pickerOpen ? null : t.id)}
                      className="rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-50"
                    >
                      Transfer
                    </button>
                  )}
                  {/* Create bucket from transaction */}
                  {t.status === 'posted' && !isTransfer && (
                    <button
                      onClick={() =>
                        navigate('/buckets', {
                          state: {
                            fromTransactionId: t.id,
                            name: cleanBucketName(t.merchantDescription),
                            targetAmountCents: Math.abs(t.amountCents),
                          },
                        })
                      }
                      className="rounded border border-green-200 px-1.5 py-0.5 text-xs text-green-700 hover:bg-green-50"
                    >
                      + Bucket
                    </button>
                  )}
                </div>
              </div>
              {/* Transfer picker */}
              {pickerOpen && candidates.length > 0 && (
                <div className="ml-4 rounded border border-purple-200 bg-purple-50 p-2">
                  <div className="mb-1 text-xs font-medium text-purple-700">
                    Select the matching transaction:
                  </div>
                  <ul className="max-h-32 space-y-1 overflow-y-auto">
                    {candidates.map((c) => (
                      <li key={c.id} className="flex items-center justify-between">
                        <span className="truncate text-xs text-neutral-700">
                          {c.merchantDescription} — {new Date(c.postedAt).toLocaleDateString()}
                        </span>
                        <button
                          onClick={() => markAsTransfer(t, c.id)}
                          className="ml-2 shrink-0 rounded bg-purple-600 px-2 py-0.5 text-xs text-white hover:bg-purple-700"
                        >
                          Link
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {transactions.length >= PAGE_SIZE && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}

      {undoInfo && (
        <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg">
          <span className="max-w-xs truncate">{undoInfo.txnName}</span>
          <span className="text-neutral-400">categorized</span>
          {undoInfo.recategorizedIds.length > 0 && (
            <span className="text-neutral-400">
              +{undoInfo.recategorizedIds.length} similar
            </span>
          )}
          <button
            onClick={undoCategory}
            className="ml-1 rounded bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
