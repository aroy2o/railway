/**
 * Redux store configuration.
 *
 * State is split in two on purpose:
 *   - SERVER state (tasks, corridors, schedules, health) is owned by the RTK
 *     Query `api` slice, which handles fetching, caching and invalidation.
 *   - CLIENT state (auth session, policy-slider positions, current selection)
 *     lives in hand-written slices under ./slices.
 *
 * Keeping that line clear is what stops the store filling up with hand-managed
 * copies of data the server already owns. See docs/DECISIONS.md D-003.
 */
import { configureStore } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'
import { api } from '../api/apiSlice.ts'
import authReducer from './slices/authSlice.ts'

export const store = configureStore({
  reducer: {
    [api.reducerPath]: api.reducer,
    auth: authReducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(api.middleware),
})

// Enables RTK Query's refetch-on-focus / refetch-on-reconnect behaviour, which
// is what keeps a dashboard left open during a demo from showing stale data.
setupListeners(store.dispatch)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
