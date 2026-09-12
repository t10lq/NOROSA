/**
 * Device key vault.
 *
 * Olm keeps every secret (identity account, ratchet state, Megolm groups) in
 * pickles encrypted with a single pickle key — a fresh random DEVICE key
 * minted per session (openDeviceKey()). Nothing persisted can unlock it: a
 * copied IndexedDB is unusable and nothing survives a session, which is
 * exactly the right property for ephemeral rooms.
 */

import { b64Encode } from './encoding'
import { IdbStore } from './idb'

const VAULT_KEY = 'vault'
const DEVICE_KEY_BYTES = 32

interface VaultRecord {
  v: 1
  salt: string
  iv: string
  data: string
  iter: number
}

export async function hasVault(): Promise<boolean> {
  return (await IdbStore.get<VaultRecord>(VAULT_KEY)) !== undefined
}

/**
 * Auto flow — the app no longer asks for a passphrase before entering a room.
 * Every session mints a fresh random DEVICE key that exists only in memory:
 * nothing persisted can unlock it, so nothing survives a session — exactly the
 * right property for ephemeral rooms. If a legacy passphrase vault exists on
 * this device (created before this flow), it is wiped: its identity can no
 * longer be re-derived and the session starts clean.
 */
export async function openDeviceKey(): Promise<string> {
  if (await hasVault()) await IdbStore.clear()
  return b64Encode(crypto.getRandomValues(new Uint8Array(DEVICE_KEY_BYTES)))
}