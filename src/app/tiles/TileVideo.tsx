import { useRef, useEffect } from 'react'

// ── Live video mount ──────────────────────────────────────────────
export function TileVideo({ stream, mirrored, muted }: { stream: MediaStream | null; mirrored?: boolean; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    void el.play().catch(() => {})
    return () => { el.srcObject = null }
  }, [stream])
  return (
    <video ref={ref} autoPlay playsInline muted={muted ?? false}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
        transform: mirrored ? 'scaleX(-1)' : undefined, background: '#0a0a0b',
      }} />
  )
}