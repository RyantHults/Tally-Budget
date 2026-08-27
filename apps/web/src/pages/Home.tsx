import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type Bucket,
  type FtsResult,
  type UpcomingEvent,
} from '../lib/api'
import { useAuth } from '../stores/auth'
import { formatCents } from '@tally/core'

const POLL_MS = 15_000
const NEAR_TARGET_PCT = 0.8
const LOW_FTS_THRESHOLD = 10_000 // $100 in cents

function humanizeDate(iso: string): string {
  const now = new Date()
  const date = new Date(iso + 'T00:00:00')
  const diffMs = date.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diffDays = Math.round(diffMs / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays < 7) return `In ${diffDays} days`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function StatCard({ label, cents, className }: { label: string; cents: number; className?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${className ?? ''}`}>
        {formatCents(cents)}
      </div>
    </div>
  )
}

export default function Home() {
  const activeBudgetId = useAuth((s) => s.activeBudgetId)
  const [fts, setFts] = useState<FtsResult | null>(null)
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (budgetId: string) => {
    const [ftsResult, upcomingResult, bucketResult] = await Promise.all([
      api.get<FtsResult>(`/budgets/${budgetId}/fts`),
      api.get<UpcomingEvent[]>(`/budgets/${budgetId}/upcoming`),
      api.get<Bucket[]>(`/budgets/${budgetId}/buckets`),
    ])
    setFts(ftsResult)
    setUpcoming(upcomingResult)
    setBuckets(bucketResult)
  }, [])

  useEffect(() => {
    if (!activeBudgetId) return
    load(activeBudgetId).catch(() => setError('Failed to load budget overview.'))
  }, [activeBudgetId, load])

  useEffect(() => {
    if (!activeBudgetId) return
    intervalRef.current = setInterval(() => {
      load(activeBudgetId).catch(() => {})
    }, POLL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [activeBudgetId, load])

  const nearTargetBuckets = buckets.filter((b) => {
    if (b.targetAmountCents <= 0) return false
    return b.currentBalanceCents >= b.targetAmountCents * NEAR_TARGET_PCT
  })
  const lowFts = fts !== null && fts.ftsCents < LOW_FTS_THRESHOLD

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Home</h1>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* FTS hero */}
      {fts && (
        <section className="rounded-lg border border-neutral-200 bg-white p-6">
          <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Free to Spend
          </div>
          <div
            className={`mt-1 text-4xl font-bold tabular-nums ${
              fts.ftsCents < 0 ? 'text-red-600' : 'text-neutral-900'
            }`}
          >
            {formatCents(fts.ftsCents)}
          </div>
          {fts.ftsCents < 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Free-to-Spend is negative — pull money from a bucket to correct it.{' '}
              <Link to="/buckets" className="font-medium text-amber-900 underline">
                Go to Buckets
              </Link>
            </div>
          )}
        </section>
      )}

      {/* Stat cards */}
      {fts && (
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Allocated" cents={fts.allocatedCents} />
          <StatCard
            label="Total Balance"
            cents={fts.balanceCents}
            className={fts.balanceCents < 0 ? 'text-red-600' : 'text-green-700'}
          />
        </div>
      )}

      {/* Quick summary chips */}
      {(nearTargetBuckets.length > 0 || lowFts) && (
        <div className="flex flex-wrap gap-2">
          {nearTargetBuckets.map((b) => (
            <span
              key={b.id}
              className="inline-flex items-center gap-1 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-800"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              {b.name} nearing target
            </span>
          ))}
          {lowFts && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              Low Free-to-Spend
            </span>
          )}
        </div>
      )}

      {/* Upcoming funding events */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-medium">Upcoming Funding Events</h2>
        </div>
        {upcoming.length === 0 ? (
          <p className="px-5 py-4 text-sm text-neutral-500">
            No upcoming events — add buckets with funding schedules to see them here.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {upcoming.map((ev) => (
              <li key={ev.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <span className="text-sm font-medium">{ev.bucketName}</span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {humanizeDate(ev.dueDate)}
                  </span>
                </div>
                <span className="text-sm tabular-nums text-neutral-700">
                  {formatCents(ev.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
