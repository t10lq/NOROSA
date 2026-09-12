/**
 * Device key vault — the difference between "files are enough" and "only the
 * passphrase opens the store".
 *
 * Olm keeps every secret (identity account, ratchet state, Megolm groups) in
 * pickles that are encrypted with a single pickle key. Previously that key was
 * a compile-time constant (idb.ts), so a copied IndexedDB could be unlocked
 * with public knowledge. Now the pickle key is a fresh random DEVICE KEY that
 * is never stored in the clear: it lives unwrapped only for the duration of
 * the page session, re-derived from the user's passphrase each time.
 *
 *   passphrase ──PBKDF2(SHA-256, salt, 600k)──▶ KEK (non-extractable)
 *   KEK + new random IV ──AES-GCM──▶ wraps the device key at rest
 *
 *   IndexedDB holds: pickles (useless) + {salt, iv, wrapped-device-key}
 *   → nothing usable without the passphrase, and nothing reusable after the
 *   attacker offlines the page.
 */

import { b64Decode, b64Encode, utf8ToBytes } from './encoding'
import { IdbStore } from './idb'

const VAULT_KEY = 'vault'
/** OWASP-recommended envelope for a human passphrase (browser-feasible). */
const ITERATIONS = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12
const DEVICE_KEY_BYTES = 32

interface VaultRecord {
  v: 1
  salt: string
  iv: string
  data: string
  iter: number
}

async function deriveKek(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8ToBytes(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    // Non-extractable: JS cannot dump the KEK, it exists only inside WebCrypto
    // for the duration of this page session.
    false,
    ['encrypt', 'decrypt'],
  )
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

/**
 * Last-resort escape when the passphrase is lost: wipe the vault AND the
 * pickled keystore. Nothing is recoverable — the identity starts completely
 * fresh. By design there is no softer backdoor.
 */
export async function resetVault(): Promise<void> {
  await IdbStore.clear()
}

/**
 * First run: mint a random device key, wrap it, and forget both the passphrase
 * and the device key. Returns the base64 DEVICE key — the pickle key the
 * caller must keep only in memory.
 */
export async function createVault(passphrase: string): Promise<string> {
  if (await hasVault()) throw new Error('A vault already exists on this device.')
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const deviceKey = crypto.getRandomValues(new Uint8Array(DEVICE_KEY_BYTES))
  const kek = await deriveKek(passphrase, salt, ITERATIONS)
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, deviceKey))
  const record: VaultRecord = { v: 1, salt: b64Encode(salt), iv: b64Encode(iv), data: b64Encode(data), iter: ITERATIONS }
  await IdbStore.set(VAULT_KEY, record)
  return b64Encode(deviceKey)
}

/**
 * Unlock an existing vault. Wrong passphrase surfaces as a GCM auth failure
 * (AES-GCM integrity keeps a wrong key from ever yielding bytes).
 */
export async function unlockVault(passphrase: string): Promise<string> {
  const record = await IdbStore.get<VaultRecord>(VAULT_KEY)
  if (!record) throw new Error('No vault found on this device.')
  const kek = await deriveKek(passphrase, b64Decode(record.salt), record.iter)
  try {
    const deviceKey = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64Decode(record.iv) }, kek, b64Decode(record.data)),
    )
    return b64Encode(deviceKey)
  } catch {
    throw new Error('Wrong passphrase.')
  }
}