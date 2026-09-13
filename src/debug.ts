/**
 * DEBUG-gated diagnostics for the media plane.
 *
 * Every ad hoc `[debug]` trace left over from past investigations funnels
 * through `dbg`, which is silent unless DEBUG is on:
 *
 *   • Development builds (the Figma Make preview / `vite dev`) always trace.
 *   • Production builds trace only while
 *       localStorage.setItem('norosa:debug', '1')
 *     is set (`'0'` or removal turns it off again — runtime toggleable).
 *
 * Genuine warnings (`console.warn`) stay ungated — they are failures, not
 * traces.
 */
const FLAG = 'norosa:debug'
const enabled = ((): boolean => {
  try {
    if (import.meta.env.DEV) return true
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
})()

/** True when `dbg` output is live (drives attaching reactive listeners too). */
export const debugEnabled = enabled

/** Diagnostic trace — compiled out of production unless the flag is set. */
export function dbg(...args: unknown[]): void {
  if (!enabled) return
  console.log('[debug]', ...args)
}