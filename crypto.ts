import 'fake-indexeddb/auto'

import {
  OlmMachine,
  UserId,
  DeviceId,
  DeviceLists,
  RequestType,
  DecryptionSettings,
  TrustRequirement,
  RoomId,
  ShieldColor,
  EncryptionSettings,
  CollectStrategy,
  type OutgoingRequest,
  type ProcessedToDeviceEvent,
} from '@matrix-org/matrix-sdk-crypto-wasm'

import {
  MatrixClient,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk'

// ---------------------------------------------------------------------------
// OlmMachine lifecycle
// ---------------------------------------------------------------------------

let machine: OlmMachine | null = null

export async function initCrypto(
  botUserId: string,
  deviceId: string,
  storeName: string,
): Promise<void> {
  machine = await OlmMachine.initialize(
    new UserId(botUserId),
    new DeviceId(deviceId),
    storeName,
  )
  process.stderr.write(`matrix channel: crypto initialised (device ${deviceId})\n`)
}

export function closeCrypto(): void {
  machine = null
}

export function getOlmMachine(): OlmMachine {
  if (!machine) throw new Error('OlmMachine not initialised — call initCrypto first')
  return machine
}

// ---------------------------------------------------------------------------
// Outgoing crypto request dispatch
// ---------------------------------------------------------------------------

async function sendCryptoRequest(
  client: MatrixClient,
  req: OutgoingRequest,
): Promise<void> {
  let response: string

  switch (req.type) {
    case RequestType.KeysUpload: {
      const res = await client.doRequest('POST', '/_matrix/client/v3/keys/upload', null, JSON.parse(req.body))
      response = JSON.stringify(res)
      break
    }
    case RequestType.KeysQuery: {
      const res = await client.doRequest('POST', '/_matrix/client/v3/keys/query', null, JSON.parse(req.body))
      response = JSON.stringify(res)
      break
    }
    case RequestType.KeysClaim: {
      const res = await client.doRequest('POST', '/_matrix/client/v3/keys/claim', null, JSON.parse(req.body))
      response = JSON.stringify(res)
      break
    }
    case RequestType.ToDevice: {
      const r = req as any
      const path = `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`
      const res = await client.doRequest('PUT', path, null, JSON.parse(req.body))
      response = JSON.stringify(res)
      break
    }
    case RequestType.SignatureUpload: {
      const res = await client.doRequest('POST', '/_matrix/client/v3/keys/signatures/upload', null, JSON.parse(req.body))
      response = JSON.stringify(res)
      break
    }
    case RequestType.RoomMessage: {
      const r = req as any
      const path = `/_matrix/client/v3/rooms/${encodeURIComponent(r.room_id)}/send/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`
      const res = await client.doRequest('PUT', path, null, JSON.parse(req.body))
      response = JSON.stringify(res)
      break
    }
    default:
      process.stderr.write(`matrix channel: unknown crypto request type ${req.type}, skipping\n`)
      return
  }

  const m = getOlmMachine()
  await m.markRequestAsSent(req.id!, req.type, response)
}

export async function processOutgoingRequests(client: MatrixClient): Promise<void> {
  const m = getOlmMachine()
  const requests = await m.outgoingRequests()
  for (const req of requests) {
    try {
      await sendCryptoRequest(client, req)
    } catch (err) {
      process.stderr.write(`matrix channel: crypto request (type=${req.type}) failed: ${err}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Sync data feed
// ---------------------------------------------------------------------------

export async function feedCryptoSync(raw: any): Promise<void> {
  const m = getOlmMachine()

  // Extract to-device events
  const toDeviceEvents = raw?.to_device?.events ?? []
  const toDeviceJSON = JSON.stringify(toDeviceEvents)

  // Extract device list changes
  const changed = (raw?.device_lists?.changed ?? []).map((u: string) => new UserId(u))
  const left = (raw?.device_lists?.left ?? []).map((u: string) => new UserId(u))
  const deviceLists = new DeviceLists(changed, left)

  // Extract one-time key counts
  const otkCounts = new Map<string, number>()
  const rawCounts = raw?.device_one_time_keys_count ?? {}
  for (const [alg, count] of Object.entries(rawCounts)) {
    otkCounts.set(alg, count as number)
  }

  // Unused fallback keys
  const unusedFallbacks = raw?.device_unused_fallback_key_types
    ? new Set<string>(raw.device_unused_fallback_key_types)
    : undefined

  const decryptionSettings = new DecryptionSettings(TrustRequirement.Untrusted)

  const processed: ProcessedToDeviceEvent[] = await m.receiveSyncChanges(
    toDeviceJSON,
    deviceLists,
    otkCounts,
    unusedFallbacks,
    decryptionSettings,
  )

  // Check for verification requests in processed events
  for (const evt of processed) {
    try {
      // DecryptedToDeviceEvent and PlainTextToDeviceEvent both have rawEvent or can be inspected
      const raw = 'rawEvent' in evt ? (evt as any).rawEvent : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.type === 'm.key.verification.request') {
          process.stderr.write(`matrix channel: received m.key.verification.request from ${parsed.sender}\n`)
        }
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CryptoMatrixClient — hooks sync for crypto
// ---------------------------------------------------------------------------

export class CryptoMatrixClient extends MatrixClient {
  constructor(homeserverUrl: string, accessToken: string, storage?: SimpleFsStorageProvider) {
    super(homeserverUrl, accessToken, storage)
  }

  protected async processSync(raw: any, emitFn?: (emitEventType: string, ...payload: any[]) => Promise<any>): Promise<any> {
    // Feed crypto BEFORE the base class processes the sync
    if (machine) {
      try {
        await feedCryptoSync(raw)
        await processOutgoingRequests(this)
      } catch (err) {
        process.stderr.write(`matrix channel: crypto sync processing failed: ${err}\n`)
      }
    }

    return super.processSync(raw, emitFn)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function isRoomEncrypted(client: MatrixClient, roomId: string): Promise<boolean> {
  try {
    await client.getRoomStateEvent(roomId, 'm.room.encryption', '')
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Room event decryption
// ---------------------------------------------------------------------------

export type DecryptionResult = {
  event: Record<string, unknown>
  shieldColor: number // ShieldColor enum value: Red=0, Grey=1, None=2
  shieldMessage?: string
}

export async function decryptRoomEvent(
  roomId: string,
  event: Record<string, unknown>,
): Promise<DecryptionResult> {
  const m = getOlmMachine()
  const decrypted = await m.decryptRoomEvent(
    JSON.stringify(event),
    new RoomId(roomId),
    new DecryptionSettings(TrustRequirement.Untrusted),
  )
  const shield = decrypted.shieldState(true)
  const clearEvent = JSON.parse(decrypted.event)
  return {
    event: clearEvent,
    shieldColor: shield.color,
    shieldMessage: shield.message ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Outbound encryption
// ---------------------------------------------------------------------------

export async function encryptIfNeeded(
  client: MatrixClient,
  roomId: string,
  eventType: string,
  content: Record<string, unknown>,
): Promise<{ eventType: string; content: Record<string, unknown> }> {
  if (!machine) return { eventType, content }
  const encrypted = await isRoomEncrypted(client, roomId)
  if (!encrypted) return { eventType, content }

  const m = getOlmMachine()

  // Track room members
  const members = await client.getJoinedRoomMembers(roomId)
  const userIds = members.map((uid: string) => new UserId(uid))
  await m.updateTrackedUsers(userIds)

  // Claim missing one-time keys
  const missingSessions = await m.getMissingSessions(userIds)
  if (missingSessions) {
    const resp = await client.doRequest('POST', '/_matrix/client/v3/keys/claim', null, JSON.parse(missingSessions.body))
    await m.markRequestAsSent(missingSessions.id, missingSessions.type, JSON.stringify(resp))
  }

  // Share room key with trusted devices only
  const settings = new EncryptionSettings()
  settings.sharingStrategy = CollectStrategy.onlyTrustedDevices()
  const shareRequests = await m.shareRoomKey(new RoomId(roomId), userIds, settings)
  for (const req of shareRequests) {
    try {
      await sendCryptoRequest(client, req)
    } catch (err) {
      process.stderr.write(`matrix channel: shareRoomKey request failed: ${err}\n`)
    }
  }

  // Encrypt the event
  const encryptedPayload = await m.encryptRoomEvent(
    new RoomId(roomId),
    eventType,
    JSON.stringify(content),
  )
  return {
    eventType: 'm.room.encrypted',
    content: JSON.parse(encryptedPayload),
  }
}

// Re-export types that server.ts may need
export { RequestType, TrustRequirement, ShieldColor }
export type { OlmMachine, OutgoingRequest, ProcessedToDeviceEvent }
