import { create } from 'zustand'
import { api, type Budget, type User } from '../lib/api'

interface AuthState {
  user: User | null
  budgets: Budget[]
  activeBudgetId: string | null
  status: 'loading' | 'authenticated' | 'unauthenticated'
  bootstrap: () => Promise<void>
  setActiveBudget: (id: string) => void
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  budgets: [],
  activeBudgetId: null,
  status: 'loading',

  bootstrap: async () => {
    try {
      const user = await api.get<User>('/auth/me')
      const budgets = await api.get<Budget[]>('/budgets')
      const active = get().activeBudgetId ?? budgets[0]?.id ?? null
      set({ user, budgets, activeBudgetId: active, status: 'authenticated' })
    } catch {
      set({ user: null, budgets: [], status: 'unauthenticated' })
    }
  },

  setActiveBudget: (id) => set({ activeBudgetId: id }),

  login: async (email, password) => {
    await api.post('/auth/login', { email, password })
    await get().bootstrap()
  },

  logout: async () => {
    await api.post('/auth/logout').catch(() => undefined)
    set({ user: null, budgets: [], activeBudgetId: null, status: 'unauthenticated' })
  },
}))
