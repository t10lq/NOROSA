import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH ?? './data/relay.sqlite'
const db = new Database(DB_PATH, { readonly: true })

const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='otk_grants'").get()
if (!table) {
  console.error(`no otk_grants table in ${DB_PATH} — the server is running PRE-FIX code. Rebuild/restart with the updated db.ts.`)
  process.exit(1)
}

const now = Date.now()
const rows = db.prepare('SELECT asker, provider, key_id, granted_at FROM otk_grants ORDER BY granted_at ASC').all()
const otks = db.prepare('SELECT key_id, consumed AS c FROM one_time_keys ORDER BY key_id ASC').all()
const members = db.prepare('SELECT alias FROM members ORDER BY alias ASC').all()

console.log(`DB: ${DB_PATH}  |  now=${new Date(now).toLocaleTimeString()}`)
console.log(`members in room: ${members.length} -> ${members.map(m => (m as { alias: string }).alias).join(', ') || '(none)'}`)
console.log(`OTK pool: ${otks.map(o => (o as { key_id: string; c: number }).key_id + ':' + (o as { key_id: string; c: number }).c).join(' ') || '(empty)'}`)
console.log(`\notk_grants rows: ${rows.length} active reservation(s)`)
if (rows.length === 0) console.log('  (none)')

for (const r of rows) {
  const r2 = r as { asker: string; provider: string; key_id: string; granted_at: number }
  const age = Math.round((now - r2.granted_at) / 1000)
  const days = Math.floor(age / 86400)
  const h = Math.floor((age % 86400) / 3600)
  const m = Math.floor((age % 3600) / 60)
  const s = age % 60
  const ageStr = `${days}d ${h}h ${m}m ${s}s`
  console.log(`  asker=${r2.asker}  provider=${r2.provider}  keyId=${r2.key_id}  created/updated=${new Date(r2.granted_at).toLocaleTimeString()}  age_ago=${ageStr}`)
}

console.log(`\nper-pair grant count: ${rows.length} row(s) for ${members.length} member(s).`)
console.log('If this count is STABLE (and granted_at NOT refreshing) after minutes of polling, the 60s keysCache in RelayLink is holding — each poll reuses the reservation instead of minting new ones.')