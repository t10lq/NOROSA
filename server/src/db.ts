/*
 * NOROSA Relay - SQLite storage layer.
 *
 * The database holds exactly two kinds of data:
 *   1. Public key bundles (identity / signed pre-key / one-time pre-keys).
 *      These are *public* by design — a blind relay has to hold them so
 *      that two anonymous parties can bootstrap a Diffie–Hellman exchange.
 *   2. Ciphertext blobs waiting in an offline mailbox. They are opaque to us.
 *
 * The private keys never leave the client. Only the identity key and the
 * (single-use) pre-keys are visible here, and none of them can decrypt
 * anything without the peer's private keys.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { OneTimePrekey, RoomMember } from './types.js'

export interface StoredMember {
  alias: string
  roomCode: string
  identityKey: string
  ed25519: string
  signedPrekey: string
  signedPrekeySig: string
}

export interface StoredMailboxMessage {
  id: string
  to: string
  from: string
  payload: string
}

export class RelayDb {
  private readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_key   TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS members (
        alias             TEXT PRIMARY KEY,
        room_code         TEXT NOT NULL,
        identity_key      TEXT NOT NULL,
        ed25519           TEXT NOT NULL,
        signed_prekey     TEXT NOT NULL,
        signed_prekey_sig TEXT NOT NULL,
        created_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS one_time_keys (
        alias    TEXT NOT NULL,
        key_id   TEXT NOT NULL,
        key      TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (alias, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_otk_consumed ON one_time_keys (alias, consumed);

      CREATE TABLE IF NOT EXISTS mailbox (
        id         TEXT PRIMARY KEY,
        to_alias   TEXT NOT NULL,
        from_alias TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox (to_alias);

      CREATE TABLE IF NOT EXISTS otk_grants (
        asker      TEXT NOT NULL,
        provider   TEXT NOT NULL,
        key_id     TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (asker, provider)
      );
    `)
    this.db.prepare('DELETE FROM mailbox WHERE created_at < ?').run(Date.now() - 24 * 60 * 60 * 1000)
  }

  close(): void {
    this.db.close()
  }

  /**
   * Remember that a room exists — keyed ONLY by the SHA-256 of its code.
   * The plaintext code never touches this database (see roomcode.ts: the
   * digest over 72 real bits of entropy cannot be reversed or brute-forced
   * because every guess would have to round-trip through a rate-limited
   * join). Refreshing `created_at` keeps a still-active room from expiring.
   */
  upsertRoom(roomKey: string): void {
    this.db
      .prepare(
        `INSERT INTO rooms (room_key, created_at) VALUES (?, ?)
         ON CONFLICT(room_key) DO UPDATE SET created_at = excluded.created_at`,
      )
      .run(roomKey, Date.now())
  }

  /** The room row, if the (hashed) key exists. Name stays honest: this is a digest lookup. */
  getRoom(roomKey: string): { roomKey: string; createdAt: number } | undefined {
    const row = this.db
      .prepare('SELECT room_key AS roomKey, created_at AS createdAt FROM rooms WHERE room_key = ?')
      .get(roomKey) as { roomKey: string; createdAt: number } | undefined
    return row
  }

  /** Register or refresh a member's public key bundle inside a room. */
  upsertMember(alias: string, roomCode: string, member: RoomMember): void {
    this.db
      .prepare(
        `INSERT INTO members (alias, room_code, identity_key, ed25519, signed_prekey, signed_prekey_sig, created_at)
         VALUES (@alias, @roomCode, @identityKey, @ed25519, @signedPrekey, @signedPrekeySig, @createdAt)
         ON CONFLICT(alias) DO UPDATE SET
           identity_key      = excluded.identity_key,
           ed25519           = excluded.ed25519,
           signed_prekey     = excluded.signed_prekey,
           signed_prekey_sig = excluded.signed_prekey_sig`,
      )
      .run({ ...member, alias, roomCode, createdAt: Date.now() })
  }

  /**
   * Replace the member's one-time pre-key pool.
   * The server only ever exposes one key of the pool to a peer and then
   * consumes it, so no two sessions can bootstrap from the same key.
   */
  replaceOneTimeKeys(alias: string, keys: OneTimePrekey[]): void {
    const done = this.db.transaction((rows: OneTimePrekey[]) => {
      this.db.prepare('UPDATE one_time_keys SET consumed = 1 WHERE alias = ?').run(alias)
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO one_time_keys (alias, key_id, key, consumed) VALUES (?, ?, ?, 0)',
      )
      for (const k of rows) insert.run(alias, k.keyId, k.key)
    })
    done(keys)
  }

  /** Fetch another member's bundle plus a freshly consumed one-time pre-key.
   *
   *  A one-time pre-key is RESERVED per (asker, provider) pair — never consumed
   *  on every keys.get. The chat grid and the media reconcile poll keys.get
   *  every few seconds; consuming on each poll drained a 20-key pool in ~60s
   *  and every later X3DH bootstrap silently fell back to the signed pre-key
   *  alone — forward secrecy quietly disabled. The first fetch by a given
   *  socket reserves one key for that socket's lifetime; each reconnect mints
   *  a fresh socket (new asker alias) and reserves a fresh key, which is
   *  correct — a fresh double-ratchet session is bootstrapped anyway. */
  getPeerKeys(
    roomCode: string,
    excludeAlias: string,
  ): Record<string, { keys: RoomMember; oneTimeKey?: OneTimePrekey }> {
    const rows = this.db
      .prepare(
        "SELECT alias, identity_key AS identityKey, ed25519, signed_prekey AS signedPrekey, signed_prekey_sig AS signedPrekeySig FROM members WHERE room_code = ? AND alias <> ? AND identity_key <> ''",
      )
      .all(roomCode, excludeAlias) as unknown as StoredMember[]

    const grantedKeyId = this.db.prepare(
      'SELECT key_id FROM otk_grants WHERE asker = ? AND provider = ?',
    )
    const otkByKeyId = this.db.prepare(
      'SELECT key_id, key FROM one_time_keys WHERE alias = ? AND key_id = ?',
    )

    const out: Record<string, { keys: RoomMember; oneTimeKey?: OneTimePrekey }> = {}
    for (const row of rows) {
      let otk: { key_id: string; key: string } | undefined
      const reserved = grantedKeyId.get(excludeAlias, row.alias) as { key_id: string } | undefined
      if (reserved) {
        // Already handed this socket a key for this provider — re-offer the
        // SAME reservation instead of pulling + consuming a new one.
        otk = otkByKeyId.get(row.alias, reserved.key_id) as { key_id: string; key: string } | undefined
      } else {
        otk = this.db
          .prepare(
            `SELECT key_id, key FROM one_time_keys
             WHERE alias = ? AND consumed = 0 ORDER BY key_id LIMIT 1`,
          )
          .get(row.alias) as { key_id: string; key: string } | undefined
        if (otk) {
          this.db.prepare('UPDATE one_time_keys SET consumed = 1 WHERE alias = ? AND key_id = ?').run(row.alias, otk.key_id)
          this.db.prepare(
            'INSERT OR REPLACE INTO otk_grants (asker, provider, key_id, granted_at) VALUES (?, ?, ?, ?)',
          ).run(excludeAlias, row.alias, otk.key_id, Date.now())
        }
      }

      out[row.alias] = {
        keys: {
          identityKey: row.identityKey,
          ed25519: row.ed25519,
          signedPrekey: row.signedPrekey,
          signedPrekeySig: row.signedPrekeySig,
        },
        oneTimeKey: otk ? { keyId: otk.key_id, key: otk.key } : undefined,
      }
    }
    return out
  }

  /** Persist an opaque ciphertext blob for offline delivery. */
  storeMailbox(from: string, to: string, id: string, payload: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO mailbox (id, to_alias, from_alias, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, to, from, payload, Date.now())
  }

  /** Drain the mailbox of one member; purges every delivered blob. */
  drainMailbox(alias: string): StoredMailboxMessage[] {
    const rows = this.db
      .prepare('SELECT id, to_alias AS "to", from_alias AS "from", payload FROM mailbox WHERE to_alias = ?')
      .all(alias) as unknown as StoredMailboxMessage[]
    for (const row of rows) this.db.prepare('DELETE FROM mailbox WHERE id = ?').run(row.id)
    return rows
  }

  /**
   * Presence pruning: once a socket is gone its alias can never be addressed
   * again (the relay mints a fresh alias per connection), so its member row
   * and one-time keys are pure clutter — stale aliases with the same identity
   * would otherwise shadow the live device in every keys.get.
   */
  removeMember(alias: string): void {
    this.db.prepare('DELETE FROM one_time_keys WHERE alias = ?').run(alias)
    this.db.prepare('DELETE FROM members WHERE alias = ?').run(alias)
    this.db.prepare('DELETE FROM otk_grants WHERE asker = ? OR provider = ?').run(alias, alias)
  }

  listMembers(roomCode: string): { alias: string }[] {
    return this.db.prepare('SELECT alias FROM members WHERE room_code = ?').all(roomCode) as { alias: string }[]
  }

  countMembers(roomCode: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_code = ?').get(roomCode) as { n: number }).n
  }

  /**
   * Sweep every mailbox blob addressed to a member that no longer exists —
   * by definition undeliverable (a dead alias is never re-addressed; each
   * connection gets a fresh one). Call after the last member of a room
   * leaves, so a fully empty room leaves zero trace in the database.
   */
  purgeOrphanMailbox(): void {
    this.db.prepare(
      `DELETE FROM mailbox
       WHERE to_alias NOT IN (SELECT alias FROM members)
          OR from_alias NOT IN (SELECT alias FROM members)`,
    ).run()
  }

  /**
   * A blind server that "retains nothing" must not keep a single row across
   * restarts: on boot there are no live sockets, so every member and every
   * mailbox blob is a corpse or an orphan by definition. Clients re-upload
   * their public material on the next hello anyway.
   */
  reset(): void {
    this.db.prepare('DELETE FROM one_time_keys').run()
    this.db.prepare('DELETE FROM mailbox').run()
    this.db.prepare('DELETE FROM members').run()
    this.db.prepare('DELETE FROM rooms').run()
    this.db.prepare('DELETE FROM otk_grants').run()
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  /** Delete mailbox entries older than the TTL — the relay forgets with time. */
  purgeExpiredMailbox(olderThanMs: number): number {
    const res = this.db
      .prepare('DELETE FROM mailbox WHERE created_at < ?')
      .run(Date.now() - olderThanMs)
    return res.changes
  }

  /** Wipe every trace of the room: members, pre-keys, and mailbox blobs. */
  destroyRoom(roomCode: string): void {
    const aliases = this.db
      .prepare('SELECT alias FROM members WHERE room_code = ?')
      .all(roomCode) as unknown as { alias: string }[]

    const done = this.db.transaction((): void => {
      for (const { alias } of aliases) {
        this.db.prepare('DELETE FROM one_time_keys WHERE alias = ?').run(alias)
        this.db.prepare('DELETE FROM mailbox WHERE to_alias = ? OR from_alias = ?').run(alias, alias)
        this.db.prepare('DELETE FROM members WHERE alias = ?').run(alias)
        this.db.prepare('DELETE FROM otk_grants WHERE asker = ? OR provider = ?').run(alias, alias)
      }
      this.db.prepare('DELETE FROM rooms WHERE room_key = ?').run(roomCode)
    })
    done()
  }
}