/**
 * IndexedDB key store — private keys and ratchet state never leave the device.
 *
 * Everything sensitive is pickled by Olm before it is written here. The DB
 * itself is still readable by any script on the origin, which is why the
 * pickle key is NOT a constant: it is a per-device random key wrapped under a
 * passphrase-derived KEK (see vault.ts), so a copied store is useless without
 * the passphrase.
 */

const DB_NAME = 'norosa-e2ee'
const DB_VERSION = 1
const STORE = 'kv'

interface KvRecord { k: string; v: unknown }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
  })
}

async function withStore<T>(action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const req = action(tx.objectStore(STORE))
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
      req.onsuccess = () => resolve(req.result as T)
    })
  } finally {
    db.close()
  }
}

export const IdbStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const rec = await withStore<KvRecord | undefined>(s => s.get(key) as IDBRequest<KvRecord | undefined>)
    return rec?.v as T | undefined
  },

  async set(key: string, value: unknown): Promise<void> {
    await withStore(s => s.put({ k: key, v: value } as KvRecord, key))
  },

  async delete(key: string): Promise<void> {
    await withStore(s => s.delete(key))
  },

  async keys(prefix: string): Promise<string[]> {
    const all = await withStore<KvRecord[]>(s => s.getAll() as IDBRequest<KvRecord[]>)
    return all.filter(r => r.k.startsWith(prefix)).map(r => r.k)
  },

  /** Wipe the entire device keystore (used by room.destroy). */
  async clear(): Promise<void> {
    await withStore(s => s.clear())
  },
}

export const ACCOUNT_KEY = 'account'
export const sessionKeyOf = (peer: string) => `session:${peer}`
export const outboundGroupKeyOf = (id: string) => `outgroup:${id}`
export const inboundGroupKeyOf = (id: string) => `ingroup:${id}`
/** Per-DEVICE-pair AES-256 media key (base64). Scoped by BOTH X3DH identity
 *  keys (curve25519) — the stable device anchor that survives reconnects —
 *  NEVER by the per-connection alias, which the relay mints fresh on every
 *  socket. Alias-keying split the cell the moment either side reconnected
 *  (the offerer wrote it under its stale alias, the answerer under a fresh
 *  one — different keys, de-synced on reload). Identity keys also make the
 *  cell symmetric: either device reads the same agreed key no matter who
 *  becomes offerer, so a role flip after reconnect stays consistent. */
export const mediaKeyKeyOf = (selfIdKey: string, peerIdKey: string) => `mediakey:${selfIdKey}:${peerIdKey}`