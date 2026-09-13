import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { E2eEncryptionService } from '../crypto/E2eEncryptionService'

/**
 * E2E encryption lifecycle.
 *
 * The provider owns exactly ONE E2eEncryptionService per (relayUrl, roomCode)
 * and exposes its readiness so the UI can gate the room behind the crypto
 * protocol. It is deliberately StrictMode-safe: the effect's cleanup destroys
 * and disposes any service that is still in flight, and a `cancelled` flag
 * prevents a zombie service (whose socket keeps dialing in the background)
 * from ever being published to consumers.
 */

export interface E2eContextValue {
  service: E2eEncryptionService | null
  isReady: boolean
  error: string | null
  roomCode: string
  destroyRoom: () => void
}

const E2eContext = createContext<E2eContextValue | null>(null)

export function E2eProvider({ relayUrl, roomCode, createRoom, pickleKey, children }: {
  relayUrl: string
  roomCode: string
  /** Whether this device originates the room (create) or joins an existing one. */
  createRoom: boolean
  /** Passphrase-unlocked device key that unlocks the Olm pickles (vault.ts). */
  pickleKey: string
  children: ReactNode
}) {
  const [service, setService] = useState<E2eEncryptionService | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const liveRef = useRef<E2eEncryptionService | null>(null)

  useEffect(() => {
    // No room code (lobby) → nothing to encrypt yet.
    if (!roomCode) {
      liveRef.current?.dispose()
      liveRef.current = null
      setService(null)
      setIsReady(false)
      setError(null)
      return
    }
    // No unlocked device key → the chat cannot open pickles (and must never
    // fall back to a constant).
    if (!pickleKey) {
      setService(null)
      setIsReady(false)
      setError('Unlock this device before entering the room.')
      return
    }

    // Reset before the next boot.
    setService(null)
    setIsReady(false)
    setError(null)

    let cancelled = false

    E2eEncryptionService.create(relayUrl, roomCode, pickleKey, createRoom)
      .then(async svc => {
        // The effect was torn down (StrictMode double-mount, or a room switch)
        // while create() was still dialing → dispose the ghost quietly. Never
        // destroy the room here: a mere remount must not wipe the peer.
        if (cancelled) {
          svc.dispose()
          return
        }
        liveRef.current = svc
        setService(svc)
        try {
          await svc.generateAndUploadKeys()
          if (!cancelled) setIsReady(true)
        } catch (err) {
          if (!cancelled) setError(describeError(err, 'Failed to publish encryption keys.'))
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, 'Failed to boot the encryption engine.'))
      })

    return () => {
      cancelled = true
      const current = liveRef.current
      if (current) {
        // Soft leave: tear down THIS device's transport only. The room and the
        // peer's keys stay on the relay — re-entering the same code rejoins.
        current.dispose()
        liveRef.current = null
      }
    }
  }, [relayUrl, roomCode, createRoom, pickleKey])

  const destroyRoom = useCallback(() => {
    liveRef.current?.destroyRoom()
  }, [])

  const value = useMemo<E2eContextValue>(
    () => ({ service, isReady, error, roomCode, destroyRoom }),
    [service, isReady, error, roomCode, destroyRoom],
  )

  return <E2eContext.Provider value={value}>{children}</E2eContext.Provider>
}

export function useE2e(): E2eContextValue {
  const ctx = useContext(E2eContext)
  if (!ctx) throw new Error('useE2e must be used within <E2eProvider>.')
  return ctx
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}