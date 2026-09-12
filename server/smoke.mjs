import { WebSocket } from 'ws'

const URL = 'ws://127.0.0.1:8099'
const room = 'AAA-BBB-CCC'
const txn = 't1'

function client(name) {
  const ws = new WebSocket(URL)
  const inbox = []
  ws.on('message', d => inbox.push(JSON.parse(d.toString())))
  return new Promise(res => ws.on('open', () => res({ ws, name, inbox })))
}

const a = await client('A')
const b = await client('B')

const send = (c, msg) => c.ws.send(JSON.stringify(msg))
const waitFor = (c, pred, n = 60) =>
  new Promise((res, rej) => {
    const iv = setInterval(() => {
      const m = c.inbox.find(pred)
      if (m) { clearInterval(iv); res(m) }
      else if (--n <= 0) { clearInterval(iv); rej(new Error(c.name + ' timeout: ' + JSON.stringify(c.inbox))) }
    }, 25)
  })

// handshake
send(a, { t: 'hello', roomCode: room })
send(b, { t: 'hello', roomCode: room })
const ackA = await waitFor(a, m => m.t === 'ack')
const ackB = await waitFor(b, m => m.t === 'ack')
a.alias = ackA.alias
b.alias = ackB.alias
console.log('hello ->', a.alias, b.alias)

// upload keys (await the acks so the DB is fully written before fetching)
for (const c of [a, b]) {
  c.inbox.length = 0
  send(c, {
    t: 'keys.upload', roomCode: room,
    keys: { identityKey: 'curve_' + c.name, ed25519: 'ed_' + c.name, signedPrekey: 'spk_' + c.name, signedPrekeySig: 'sig_' + c.name },
    oneTimeKeys: [{ keyId: 'otk1', key: 'otk_' + c.name }],
  })
}
await waitFor(a, m => m.t === 'ack')
await waitFor(b, m => m.t === 'ack')

// fetch peer keys (server should consume A's one-time key)
send(a, { t: 'keys.get', roomCode: room, txn })
const res = await waitFor(a, m => m.t === 'keys.result' && m.txn === txn)
const peer = Object.values(res.users)[0]
console.log('keys.result ->', JSON.stringify(peer))
if (!peer.oneTimeKey) throw new Error('one-time key was not handed out')

// route an opaque blob to B (online)
send(a, { t: 'msg', roomCode: room, to: b.alias, id: 'm1', payload: 'ENCRYPTED-BLOB-1' })
await waitFor(a, m => m.t === 'ack' && m.id === 'm1')
console.log('server acked m1; B inbox =', JSON.stringify(b.inbox))
const got = await waitFor(b, m => m.t === 'msg' && m.id === 'm1')
console.log('delivered ->', got.payload)

// destroy room
send(a, { t: 'room.destroy', roomCode: room })
await waitFor(a, m => m.t === 'ack' && m.id === undefined)

a.ws.close(); b.ws.close()
console.log('SMOKE OK')
process.exit(0)