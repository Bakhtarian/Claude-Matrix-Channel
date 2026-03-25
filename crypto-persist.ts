/**
 * Persist fake-indexeddb state to disk so the OlmMachine's identity keys,
 * Olm sessions, and megolm room keys survive across process restarts.
 *
 * Uses standard IndexedDB APIs to enumerate all databases/stores/records,
 * serializes to JSON (with base64 encoding for binary data), and restores
 * by re-creating the databases before OlmMachine.initialize touches them.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Binary-safe JSON serialization
// ---------------------------------------------------------------------------

function serializeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __t: 'u8', d: Buffer.from(value).toString('base64') }
  }
  if (value instanceof ArrayBuffer) {
    return { __t: 'ab', d: Buffer.from(value).toString('base64') }
  }
  if (value instanceof Date) {
    return { __t: 'dt', d: value.toISOString() }
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v)
    }
    return out
  }
  return value
}

function deserializeValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
    const v = value as { __t: string; d: string }
    switch (v.__t) {
      case 'u8':
        return new Uint8Array(Buffer.from(v.d, 'base64'))
      case 'ab':
        return Buffer.from(v.d, 'base64').buffer
      case 'dt':
        return new Date(v.d)
    }
  }
  if (Array.isArray(value)) {
    return value.map(deserializeValue)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deserializeValue(v)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// IndexedDB snapshot types
// ---------------------------------------------------------------------------

type DbSnapshot = {
  name: string
  version: number
  stores: StoreSnapshot[]
}

type StoreSnapshot = {
  name: string
  keyPath: IDBObjectStoreParameters['keyPath']
  autoIncrement: boolean
  indexes: IndexSnapshot[]
  records: { key: unknown; value: unknown }[]
}

type IndexSnapshot = {
  name: string
  keyPath: string | string[]
  unique: boolean
  multiEntry: boolean
}

// ---------------------------------------------------------------------------
// Helpers: promisified IDB operations
// ---------------------------------------------------------------------------

function idbOpen(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbReadAll(store: IDBObjectStore): Promise<{ key: unknown; value: unknown }[]> {
  return new Promise((resolve, reject) => {
    const results: { key: unknown; value: unknown }[] = []
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        results.push({ key: cursor.key, value: cursor.value })
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

function idbTxComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot all IndexedDB databases to a JSON file.
 * Uses atomic write (write to .tmp then rename).
 */
export async function saveCryptoStore(stateDir: string): Promise<void> {
  const filePath = join(stateDir, 'crypto-store.json')
  const tmpPath = `${filePath}.tmp`

  const databases = await indexedDB.databases()
  const snapshot: DbSnapshot[] = []

  for (const dbInfo of databases) {
    if (!dbInfo.name) continue
    const db = await idbOpen(dbInfo.name, dbInfo.version)

    const stores: StoreSnapshot[] = []
    for (const storeName of db.objectStoreNames) {
      const tx = db.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)

      const indexes: IndexSnapshot[] = []
      for (const indexName of store.indexNames) {
        const idx = store.index(indexName)
        indexes.push({
          name: idx.name,
          keyPath: idx.keyPath as string | string[],
          unique: idx.unique,
          multiEntry: idx.multiEntry,
        })
      }

      const records = await idbReadAll(store)

      stores.push({
        name: storeName,
        keyPath: store.keyPath as IDBObjectStoreParameters['keyPath'],
        autoIncrement: store.autoIncrement,
        indexes,
        records: records.map((r) => ({
          key: serializeValue(r.key),
          value: serializeValue(r.value),
        })),
      })
    }

    snapshot.push({ name: dbInfo.name, version: db.version, stores })
    db.close()
  }

  writeFileSync(tmpPath, JSON.stringify(snapshot))
  renameSync(tmpPath, filePath)
}

/**
 * Restore IndexedDB databases from a previously saved snapshot.
 * Must be called BEFORE OlmMachine.initialize so it finds existing data.
 * Returns true if a snapshot was found and restored.
 */
export async function restoreCryptoStore(stateDir: string): Promise<boolean> {
  const filePath = join(stateDir, 'crypto-store.json')

  let snapshot: DbSnapshot[]
  try {
    snapshot = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return false
  }

  for (const dbData of snapshot) {
    // Phase 1: create database and object stores (onupgradeneeded)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbData.name, dbData.version)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const storeData of dbData.stores) {
          const store = db.createObjectStore(storeData.name, {
            keyPath: storeData.keyPath ?? undefined,
            autoIncrement: storeData.autoIncrement,
          })
          for (const idx of storeData.indexes) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            })
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    // Phase 2: insert records into each store
    for (const storeData of dbData.stores) {
      if (storeData.records.length === 0) continue
      const tx = db.transaction(storeData.name, 'readwrite')
      const store = tx.objectStore(storeData.name)
      for (const record of storeData.records) {
        const value = deserializeValue(record.value)
        if (storeData.keyPath) {
          // Key is embedded in the value — don't pass explicit key
          store.put(value)
        } else {
          store.put(value, deserializeValue(record.key) as IDBValidKey)
        }
      }
      await idbTxComplete(tx)
    }

    db.close()
  }

  return true
}

// ---------------------------------------------------------------------------
// Debounced auto-save
// ---------------------------------------------------------------------------

let _stateDir: string | null = null
let _saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 10_000

export function enableAutoSave(stateDir: string): void {
  _stateDir = stateDir
}

/** Schedule a debounced save. Call after any crypto state change. */
export function scheduleSave(): void {
  if (!_stateDir) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(async () => {
    try {
      await saveCryptoStore(_stateDir!)
    } catch (err) {
      process.stderr.write(`matrix channel: crypto store save failed: ${err}\n`)
    }
  }, SAVE_DEBOUNCE_MS)
}

/** Force an immediate save (e.g. on shutdown). */
export async function flushSave(): Promise<void> {
  if (!_stateDir) return
  if (_saveTimer) {
    clearTimeout(_saveTimer)
    _saveTimer = null
  }
  try {
    await saveCryptoStore(_stateDir)
  } catch (err) {
    process.stderr.write(`matrix channel: crypto store flush failed: ${err}\n`)
  }
}
