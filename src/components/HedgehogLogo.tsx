const C = { x: 100, y: 74 }
const RB = 52
const RT = 88

interface Spike { pts: string; opacity: number }

const SPIKES: Spike[] = (() => {
  const out: Spike[] = []
  const n = 26
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const a = Math.PI * (0.055 + 0.84 * t)
    const pt = (r: number, ang: number) =>
      `${(C.x + r * Math.cos(ang)).toFixed(1)},${(C.y + r * Math.sin(ang)).toFixed(1)}`
    const pts = `${pt(RB, a - 0.1)} ${pt(RB, a + 0.1)} ${pt(RT, a)}`
    const off = Math.abs(a - Math.PI / 2) / (Math.PI / 2)
    out.push({ pts, opacity: 0.16 + (1 - off) * 0.68 })
  }
  return out
})()

const SPIKES_RED: Spike[] = SPIKES.map(({ pts, opacity }) => ({
  pts,
  opacity: 0.3 + opacity * 0.62,
}))

export function HedgehogLogo({ size = 160, tone = 'light', className }: {
  size?: number
  tone?: 'light' | 'red'
  className?: string
}) {
  const red = tone === 'red'
  const spikes = red ? SPIKES_RED : SPIKES
  const spikeFill = red ? '#B3241F' : '#F0EEE9'
  const bodyFill = red ? '#1D1211' : '#18181B'
  const maskFill = red ? '#150E0E' : '#111113'
  const earFill = red ? '#150E0E' : '#121216'
  const pawFill = red ? '#120C0C' : '#0D0D0F'
  const highlight = red ? 'rgba(240,238,233,0.65)' : 'rgba(240,238,233,0.45)'
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none"
      className={className} role="img" aria-label="Norosa hedgehog">
      {/* ground shadow */}
      <ellipse cx="100" cy="170" rx="56" ry="6" fill="rgba(0,0,0,0.42)" />

      {/* spikes */}
      {spikes.map((s, i) => (
        <polygon key={i} points={s.pts} fill={spikeFill} opacity={s.opacity} />
      ))}

      {/* ears */}
      <ellipse cx="70" cy="88" rx="5" ry="8" fill={earFill} transform="rotate(-16 70 88)" />
      <ellipse cx="130" cy="88" rx="5" ry="8" fill={earFill} transform="rotate(16 130 88)" />

      {/* body */}
      <path
        d="M31,116 Q31,86 52,74 Q74,62 100,62 Q126,62 148,74 Q169,86 169,116 Q169,147 146,157 Q122,166 100,166 Q78,166 54,157 Q31,147 31,116 Z"
        fill={bodyFill} stroke="rgba(240,238,233,0.07)"
      />

      {/* face mask */}
      <ellipse cx="100" cy="130" rx="34" ry="22" fill={maskFill} />

      {/* cheek hints */}
      <circle cx="77" cy="131" r="3" fill="rgba(240,238,233,0.07)" />
      <circle cx="123" cy="131" r="3" fill="rgba(240,238,233,0.07)" />

      {/* eyes (blinking group) */}
      <g className="hlog-blink">
        <ellipse cx="84" cy="121" rx="4.2" ry="4.8" fill={highlight} />
        <ellipse cx="116" cy="121" rx="4.2" ry="4.8" fill={highlight} />
        <circle cx="83.4" cy="121.6" r="1.5" fill="#0A0A0B" />
        <circle cx="115.4" cy="121.6" r="1.5" fill="#0A0A0B" />
      </g>

      {/* nose */}
      <ellipse cx="100" cy="136" rx="6" ry="4.5" fill={highlight} />

      {/* mouth */}
      <path d="M100,140.5 v4.5" stroke="rgba(240,238,233,0.45)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M97,145 Q100,147.5 103,145" stroke="rgba(240,238,233,0.35)" strokeWidth="1.6"
        strokeLinecap="round" fill="none" />

      {/* paws */}
      <ellipse cx="80" cy="161" rx="8" ry="5" fill={pawFill} />
      <ellipse cx="120" cy="161" rx="8" ry="5" fill={pawFill} />
    </svg>
  )
}