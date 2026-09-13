import { HedgehogLogo } from './HedgehogLogo'

export function LoadingScreen({ progress, hidden }: {
  progress: number
  hidden: boolean
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: '#0A0A0B',
      opacity: hidden ? 0 : 1,
      pointerEvents: hidden ? 'none' : 'auto',
      transition: 'opacity 0.5s ease',
    }}>
      <div className="hlog-enter">
        <div className="hlog-breathe">
          <HedgehogLogo size={156} />
        </div>
      </div>

      <div style={{ marginTop: 34, textAlign: 'center' }}>
        <div style={{
          fontFamily: "'Space Mono'", fontSize: 26, fontWeight: 700,
          letterSpacing: '0.22em', color: '#F0EEE9',
        }}>Norosa</div>
        <div style={{
          marginTop: 10, fontFamily: 'Outfit', fontSize: 12, color: '#4A4A52',
          fontWeight: 400, letterSpacing: '0.14em',
        }}>ESTABLISHING PRIVATE CHANNEL</div>
      </div>

      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
        <div style={{ height: 1, width: '100%', background: 'rgba(255,255,255,0.09)' }} />
        <div style={{
          height: 1,
          width: `${progress}%`,
          background: progress >= 100 ? 'rgba(240,238,233,0.18)' : '#B3241F',
          transition: 'width 0.25s linear',
        }} />
      </div>
    </div>
  )
}