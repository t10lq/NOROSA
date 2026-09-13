import { useState, useEffect } from 'react'

export function RoomBootLoader() {
  const [dots, setDots] = useState('')
  useEffect(() => {
    const iv = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 400)
    return () => clearInterval(iv)
  }, [])
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', background: '#0A0A0B', gap: 18,
    }}>
      <p style={{ fontFamily: "'Space Mono'", fontSize: 13, letterSpacing: '0.14em', color: 'rgba(240,238,233,0.55)', margin: 0 }}>
        ENTERING ENCRYPTED ROOM{dots}
      </p>
      <p style={{ fontFamily: "'Space Mono'", fontSize: 10, letterSpacing: '0.1em', color: '#2E2E35', margin: 0 }}>
        HANDSHAKE · RATE-LIMIT CHECK · IDENTITY EXCHANGE
      </p>
    </div>
  )
}