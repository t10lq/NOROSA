import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useE2e } from './E2eContext'
import { dbg } from '../debug'
import { MediaCallClient, defaultIceServers, probeEncodedStreamsCaps, type EncodedCapsProbe, type MediaCallEvents } from '../media/webrtc'

/**
 * Media-plane bridge.
 *
 * Owns exactly ONE MediaCallClient per E2eEncryptionService lifetime (audio
 * only) and exposes just enough surface for the room UI: the mute toggle
 * (real replaceTrack call — the connection never drops) and the remote stream
 * per peer for rendering.
 *
 * Permission handling: a denied microphone never kills the call (the audio
 * m-line is negotiated with a null track; granting later injects it via
 * replaceTrack). Blocked grants are surfaced as micBlocked so the room can
 * show a clear hint instead of a silent failure.
 *
 * When the browser lacks RTCRtpScriptTransform the provider stays live with
 * supported=false — pairs then run plain DTLS-SRTP media (still encrypted end
 * to end at the transport level, minus the post-transform E2EE layer) and the
 * room surfaces an honest cryptoMode badge instead of hiding media.
 */

export interface CallContextValue {
  /** null until the crypto engine is ready (or when unsupported). */
  media: MediaCallClient | null
  supported: boolean
  /** Human reason from the deep capability probe when unsupported. */
  supportReason: string | null
  /** Honest room label: 'e2ee' (every pair uses the transform layer),
   *  'legacy' (this device cannot — all pairs run DTLS-SRTP), or 'mixed'
   *  (one live peer lacks the layer; that pair runs DTLS-SRTP). */
  cryptoMode: 'e2ee' | 'legacy' | 'mixed'
  /** Remote mix per peer alias — a fresh Map instance on every change. */
  remoteStreams: ReadonlyMap<string, MediaStream>
  /** Per-peer mic muted state, driven by explicit mute signaling. */
  peerMics: ReadonlyMap<string, boolean>
  /** Peers whose inbound frames are actively failing decryption. */
  decryptDrops: ReadonlyMap<string, boolean>
  micOn: boolean
  /** A capture request is in flight (permission prompt open). */
  micPending: boolean
  /** True when the browser refused the microphone, until granted. */
  micBlocked: boolean
  /** Browser-provided reason for the refusal (NotAllowedError etc.). */
  micError: string | null
  peerStates: ReadonlyMap<string, RTCPeerConnectionState>
  toggleMic: () => void
  setMicOn: (on: boolean) => void
  reconfigureDevices: (micId: string | null) => void
}

const CallContext = createContext<CallContextValue | null>(null)

export function CallProvider({ children }: { children: ReactNode }) {
  const { service, isReady } = useE2e()
  const [media, setMedia] = useState<MediaCallClient | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<ReadonlyMap<string, MediaStream>>(new Map())
  const [peerMics, setPeerMics] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [decryptDrops, setDecryptDrops] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [peerStates, setPeerStates] = useState<ReadonlyMap<string, RTCPeerConnectionState>>(new Map())
  const [micOn, setMicOnState] = useState(true)
  const [micBlocked, setMicBlocked] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [micPending, setMicPending] = useState(false)
  const [supportProbe, setSupportProbe] = useState<EncodedCapsProbe | null>(null)
  const [cryptoMode, setCryptoMode] = useState<'e2ee' | 'legacy' | 'mixed'>('e2ee')

  const mediaRef = useRef<MediaCallClient | null>(null)
  const micOnRef = useRef(micOn)
  micOnRef.current = micOn

  useEffect(() => {
    if (!service || !isReady) return

    // Deep capability probe — some embedded webviews expose the ctor but the
    // constructed transform has no readable/writable (stubbed pipeline), so
    // E2EE media can never attach there. Log the truth instead of guessing.
    const probe = probeEncodedStreamsCaps()
    dbg('media capability probe →', JSON.stringify(probe))
    setSupportProbe(probe)

    let client: MediaCallClient | null = null
    const refreshMode = () => { if (client) setCryptoMode(client.encryptionMode()) }

    const events: MediaCallEvents = {
      onStream: (peer, stream) => {
        setRemoteStreams(prev => {
          const next = new Map(prev)
          next.set(peer, stream)
          return next
        })
        // A fresh stream may be a re-negotiation with salvaged crypto.
        setDecryptDrops(prev => {
          if (!prev.has(peer)) return prev
          const next = new Map(prev)
          next.delete(peer)
          return next
        })
        refreshMode()
      },
      onPeerState: (peer, state) => {
        setPeerStates(prev => new Map(prev).set(peer, state))
        refreshMode()
      },
      onFrameDrop: (peer) => {
        setDecryptDrops(prev => new Map(prev).set(peer, true))
      },
      onPeerMic: (peer, muted) => {
        setPeerMics(prev => new Map(prev).set(peer, muted))
      },
      onMicError: (message) => {
        setMicBlocked(true)
        setMicError(message ?? 'Permission denied')
        setMicPending(false)
        // We have no mic to send with — reflect the truth in the badge.
        setMicOnState(false)
        micOnRef.current = false
      },
    }

    let cancelled = false
    void (async () => {
      // TURN creds are minted at runtime (static-auth-secret REST scheme) — a
      // short await that resolves instantly when no TURN is configured.
      const ice = await defaultIceServers()
      if (cancelled) return
      client = new MediaCallClient(service, events, ice, probe?.supported ?? false)
      refreshMode()
      mediaRef.current = client
      setMedia(client)
      void client.start()
    })()

    return () => {
      cancelled = true
      mediaRef.current = null
      client?.dispose()
      setMedia(null)
      setRemoteStreams(new Map())
      setPeerMics(new Map())
      setPeerStates(new Map())
    }
  }, [service, isReady])

  const setMicOn = useCallback((on: boolean) => {
    const prev = micOnRef.current
    if (on) setMicPending(true)
    setMicOnState(on)
    const c = mediaRef.current
    if (!c) {
      setMicPending(false)
      if (on) setMicBlocked(true)
      return
    }
    void (async () => {
      try {
        await c.setMicOn(on)
        setMicBlocked(false)
        setMicError(null)
      } catch {
        setMicOnState(prev)
        micOnRef.current = prev
        setMicBlocked(true)
      } finally {
        setMicPending(false)
      }
    })()
  }, [])

  const toggleMic = useCallback(() => setMicOn(!micOnRef.current), [setMicOn])

  const reconfigureDevices = useCallback((micId: string | null) => {
    void (async () => {
      const c = mediaRef.current
      if (!c) return
      if (micOnRef.current) {
        try {
          await c.setMicOn(true, micId ?? 'default')
          setMicBlocked(false)
          setMicError(null)
        } catch {
          setMicBlocked(true)
        }
      }
    })()
  }, [])

  const value = useMemo<CallContextValue>(
    () => ({
      media,
      supported: supportProbe?.supported ?? false,
      supportReason: supportProbe?.reason ?? null,
      cryptoMode,
      remoteStreams,
      peerMics,
      decryptDrops,
      peerStates,
      micOn,
      micPending,
      micBlocked,
      micError,
      toggleMic,
      setMicOn,
      reconfigureDevices,
    }),
    [media, cryptoMode, remoteStreams, peerMics, decryptDrops, peerStates, micOn, micPending, micBlocked, micError, toggleMic, setMicOn, reconfigureDevices],
  )

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>
}

export function useCalls(): CallContextValue {
  const ctx = useContext(CallContext)
  if (!ctx) throw new Error('useCalls must be used within <CallProvider>.')
  return ctx
}