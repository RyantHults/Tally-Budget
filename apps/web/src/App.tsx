import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './stores/auth'
import Login from './pages/Login'
import Home from './pages/Home'
import Buckets from './pages/Buckets'
import Transactions from './pages/Transactions'
import Accounts from './pages/Accounts'
import Settings from './pages/Settings'

const NAV_ITEMS = [
  { to: '/', label: 'Home' },
  { to: '/buckets', label: 'Buckets' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/activity', label: 'Activity' },
  { to: '/settings', label: 'Settings' },
] as const

function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm opacity-60">Coming soon.</p>
    </div>
  )
}

function Shell() {
  const { user, status, logout, budgets, activeBudgetId, setActiveBudget } = useAuth()
  const navigate = useNavigate()

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-sm">Loading…</div>
  }
  if (status === 'unauthenticated' || !user) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="min-h-screen bg-slate-50 text-neutral-900">
      <div className="flex min-h-screen flex-col md:flex-row">
        {/* Sidebar (wide screens) */}
        <nav className="hidden w-56 shrink-0 border-r border-neutral-200 bg-white p-4 md:block">
          <div className="mb-6 px-2 text-lg font-bold">Tally</div>
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-2 text-sm ${
                      isActive ? 'bg-blue-50 font-medium text-blue-600' : 'hover:bg-neutral-100'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="mt-8 border-t border-neutral-100 pt-4">
            <label className="block px-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Budget
            </label>
            <select
              value={activeBudgetId ?? ''}
              onChange={(e) => setActiveBudget(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            >
              {budgets.length === 0 && <option value="">No budgets</option>}
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <div className="mt-3 px-2 text-xs text-neutral-500">{user.email}</div>
            <button
              onClick={async () => {
                await logout()
                navigate('/login')
              }}
              className="mt-2 w-full rounded-md px-2 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
            >
              Sign out
            </button>
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 pb-16 md:pb-0">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/buckets" element={<Buckets />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/activity" element={<Placeholder title="Activity" />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>

        {/* Bottom tabs (narrow screens) */}
        <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-6 border-t border-neutral-200 bg-white md:hidden">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center py-2 text-[10px] ${
                  isActive ? 'font-medium text-blue-600' : 'text-neutral-500'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap)
  const status = useAuth((s) => s.status)

  useEffect(() => {
    if (status === 'loading') bootstrap().catch(() => undefined)
  }, [status, bootstrap])

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<Shell />} />
    </Routes>
  )
}
