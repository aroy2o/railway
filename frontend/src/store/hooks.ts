/**
 * Typed Redux hooks.
 *
 * Components import these instead of the raw react-redux hooks so state and
 * dispatch are fully typed without repeating the generics at every call site.
 */
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store.ts'

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
