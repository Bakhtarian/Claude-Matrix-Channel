# Matrix Channel E2EE Design

## Goal

Add transparent end-to-end encryption support to the Matrix channel MCP server so it works in any room — encrypted or unencrypted — without requiring users to create special unencrypted rooms.

## Requirements

- **Transparent operation:** The bot works in both encrypted and unencrypted rooms.
- **Manual cross-signing verification:** The bot requires full interactive SAS (emoji comparison) verification before communicating in encrypted rooms. No trust-on-first-use or auto-trust.
- **Unverified room behavior:** Messages from unverified devices in encrypted rooms are dropped. The bot sends a one-time notice per room explaining that verification is needed.
- **No schema changes:** The existing `access.json` schema and access gate logic are unchanged. Encryption is orthogonal to access control.

## Approach: Hybrid Crypto Backend

We use `matrix-bot-sdk` for the Matrix client (sync, rooms, sending) but manage the crypto layer ourselves using `@matrix-org/matrix-sdk-crypto-wasm` (v18.0.0). This replaces the bot-sdk's built-in crypto (which uses `@matrix-org/matrix-sdk-crypto-nodejs` v0.4.0) because the nodejs bindings lack:
- SAS verification APIs (no `Sas`, `VerificationRequest`, or `Emoji` classes)
- Configurable trust strategy (`onlyAllowTrustedDevices` not exposed)
- Verification state on decrypted events (`DecryptedRoomEvent.shieldState()` discarded)

The wasm package exposes all of these.

## Design

### 1. Crypto Backend: OlmMachine via Wasm

Replace `@matrix-org/matrix-sdk-crypto-nodejs` with `@matrix-org/matrix-sdk-crypto-wasm`. Do **not** pass a `cryptoStore` to `MatrixClient` — we manage crypto outside the bot-sdk.

```typescript
import { OlmMachine, UserId, DeviceId, RoomId,
         DeviceLists, EncryptionSettings, CollectStrategy,
         DecryptionSettings, TrustRequirement, RequestType,
         VerificationMethod, ShieldColor, Attachment,
         initAsync } from '@matrix-org/matrix-sdk-crypto-wasm'

// Initialize wasm module first
await initAsync()

// Initialize once at startup
const machine = await OlmMachine.initialize(
  new UserId(botUserId),
  new DeviceId(deviceId),
  join(BOT_STORE_DIR, 'crypto'),  // store name (path for persistent storage)
  undefined                        // no passphrase
)
```

**Note on `store_name`:** The third argument is called `store_name` in the API. Under Node/Bun with the wasm package, this should map to a filesystem-backed store. The Bun+wasm smoke test (step 0 of implementation) must verify that state actually persists across restarts at this path.

The `OlmMachine` persists its state (Olm account, device keys, session keys, cross-signing keys) to the store automatically.

### 2. Sync Integration

The `OlmMachine` needs data from each sync response. We hook into the bot-sdk's raw sync processing:

**Feeding sync data to OlmMachine:**
```typescript
// After each sync response, feed crypto-relevant data to the machine
const toDeviceEvents = syncResponse.to_device?.events || []
const deviceLists = new DeviceLists(
  syncResponse.device_lists?.changed?.map(u => new UserId(u)),
  syncResponse.device_lists?.left?.map(u => new UserId(u))
)
const otkeyCounts = new Map(
  Object.entries(syncResponse.device_one_time_keys_count || {})
)

await machine.receiveSyncChanges(
  JSON.stringify(toDeviceEvents),
  deviceLists,
  otkeyCounts,
  syncResponse.device_unused_fallback_key_types
    ? new Set(syncResponse.device_unused_fallback_key_types) : undefined,
  new DecryptionSettings(TrustRequirement.Untrusted)
)
```

**Processing outgoing requests:** After `receiveSyncChanges`, the machine may have outgoing requests (key uploads, key queries, to-device messages). We process them in a loop:

```typescript
async function processOutgoingRequests() {
  const requests = await machine.outgoingRequests()
  for (const req of requests) {
    const response = await sendCryptoRequest(matrixClient, req)
    await machine.markRequestAsSent(req.id, req.type, response)
  }
}
```

`sendCryptoRequest` maps each `RequestType` to the appropriate Matrix CS API call via `matrixClient.doRequest()`:
- `KeysUpload` → `POST /_matrix/client/v3/keys/upload`
- `KeysQuery` → `POST /_matrix/client/v3/keys/query`
- `KeysClaim` → `POST /_matrix/client/v3/keys/claim`
- `ToDevice` → `PUT /_matrix/client/v3/sendToDevice/{eventType}/{txnId}`
- `SignatureUpload` → `POST /_matrix/client/v3/keys/signatures/upload`

**Hooking into matrix-bot-sdk sync:** The bot-sdk doesn't expose raw sync responses publicly. The `MatrixClient` has a `protected processSync(raw: any)` method that receives the full sync response.

We subclass `MatrixClient` to intercept the raw sync data:

```typescript
class CryptoMatrixClient extends MatrixClient {
  protected async processSync(raw: any) {
    // Feed crypto data to OlmMachine BEFORE bot-sdk processes room events.
    // This ordering is critical: receiveSyncChanges must run first so the
    // OlmMachine has session keys available when we later decrypt timeline events.
    await feedCryptoSync(raw)
    await processOutgoingRequests()

    // Then let bot-sdk handle room state, membership, timeline, etc.
    return super.processSync(raw)
  }
}
```

This keeps the bot-sdk handling room state, membership, and timeline events while we handle crypto. The ordering guarantee (crypto before room events) prevents intermittent decryption failures.

### 3. Encrypting Outbound Messages

Before sending to an encrypted room, we:
1. Check if the room is encrypted (via room state `m.room.encryption`)
2. Ensure we're sharing keys with room members: `machine.updateTrackedUsers(users)`, `machine.getMissingSessions(users)`, `machine.shareRoomKey(roomId, users, settings)`
3. Encrypt: `machine.encryptRoomEvent(roomId, eventType, JSON.stringify(content))`
4. Send the encrypted payload as `m.room.encrypted`

The `EncryptionSettings` use `CollectStrategy.onlyTrustedDevices()` so the machine refuses to encrypt for unverified devices.

```typescript
const settings = new EncryptionSettings()
settings.sharingStrategy = CollectStrategy.onlyTrustedDevices()
```

If encryption fails due to unverified devices, we catch the error and send a plaintext notice explaining verification is needed.

### 4. Decrypting Inbound Messages

When we receive an `m.room.encrypted` event in the timeline:
1. Call `machine.decryptRoomEvent(JSON.stringify(event), new RoomId(roomId))`
2. Check `decrypted.shieldState(true)` (strict mode) for verification status
3. If `shield.color` is `Red` or `Grey` → drop the message, send one-time notice. (`Grey` means the sender's identity is not verified; `Red` means something worse like a verification violation. Both are dropped since we require strict verification.)
4. If `ShieldColor.None` → pass decrypted event through the normal access gate

```typescript
if (event.type === 'm.room.encrypted') {
  const decrypted = await machine.decryptRoomEvent(
    JSON.stringify(event), new RoomId(roomId),
    new DecryptionSettings(TrustRequirement.Untrusted)
  )
  const shield = decrypted.shieldState(true)
  if (shield.color !== ShieldColor.None) {
    // Drop message, send verification notice once per room
    return
  }
  // Replace event with decrypted content for access gate
  event = JSON.parse(decrypted.event)
}
```

The existing `m.room.encrypted` warning handler is removed.

### 5. Verification Flow

Full interactive SAS verification from the terminal via a new `/matrix:verify` skill.

**Detecting incoming verification requests:**

Verification requests arrive as `m.key.verification.request` to-device events, processed by `receiveSyncChanges`. After each sync, we inspect `ProcessedToDeviceEvent` results for verification events and call `machine.getVerificationRequest(userId, flowId)` to get the `VerificationRequest` object. Pending requests are tracked so the `/matrix:verify` skill can list them.

Additionally, we log to stderr when a new verification request arrives, so the terminal user knows to run `/matrix:verify`.

**Terminal-side `/matrix:verify` skill flow:**

1. User runs `/matrix:verify` — skill lists pending verification requests
2. User selects a request (or runs `/matrix:verify @user:server` to initiate one)
3. Skill calls `request.acceptWithMethods([VerificationMethod.SasV1])`
4. Sends the resulting `OutgoingVerificationRequest` to the server
5. Calls `request.startSas()` → gets `[Sas, OutgoingVerificationRequest]`
6. Sends the SAS outgoing request to the server
7. If we are the acceptor (not initiator), calls `sas.accept()` to respond to the `m.key.verification.start` event, sends the resulting request
8. Polls `sas.canBePresented()` until true
9. Displays `sas.emoji()` — 7 emoji with descriptions (e.g., "🐶 Dog, 🔑 Key, ...")
10. User confirms match → calls `sas.confirm()` → sends resulting requests
11. Verification complete, device is now trusted

**Bot-initiated verification:**

`/matrix:verify @user:server`:
1. Get device: `const device = await machine.getDevice(new UserId(userId), new DeviceId(deviceId))` (returns `Device | undefined` — check for null)
2. Call `device.requestVerification([VerificationMethod.SasV1])`
3. Returns `[VerificationRequest, ToDeviceRequest]`
4. Send the to-device request
5. Wait for them to accept, then follow SAS flow above

**Skill interaction model:** The skill runs as an interactive loop in the terminal. It uses `AskUserQuestion` to prompt for emoji confirmation. The verification request has a timeout (`timeRemainingMillis()`), displayed to the user.

### 6. Unverified Room Behavior

When the bot receives a message in an encrypted room and the sender's device is not verified (determined by `shieldState`):

1. The message is dropped (not forwarded to Claude)
2. The bot sends a notice: "I can't read messages here until my device is verified. Please verify my device from Element (Settings > Sessions) or ask the terminal user to run /matrix:verify."
3. This notice is sent **once per room per session** (tracked in a `Set<string>` in memory). Restarting the bot resets this, which is acceptable — a single reminder after restart is fine.

For outbound messages: `CollectStrategy.onlyTrustedDevices()` prevents key sharing with unverified devices. If `shareRoomKey` or `encryptRoomEvent` throws due to this, we catch the error and send a plaintext notice.

### 7. `fetch_messages` Decryption

The current `fetch_messages` tool uses raw `GET /_matrix/client/v3/rooms/.../messages`. In encrypted rooms, this returns `m.room.encrypted` events. After fetching, we decrypt each encrypted event individually:

```typescript
for (const event of chunk) {
  if (event.type === 'm.room.encrypted') {
    try {
      const decrypted = await machine.decryptRoomEvent(...)
      event.type = JSON.parse(decrypted.event).type
      event.content = JSON.parse(decrypted.event).content
    } catch {
      event.content = { body: '[unable to decrypt]', msgtype: 'm.notice' }
    }
  }
}
```

Note: Historical messages may fail to decrypt if the bot wasn't in the room when keys were shared. This is expected behavior — we surface it as `[unable to decrypt]`.

### 8. `download_attachment` Encrypted Media

In encrypted rooms, file attachments use the `file` field (with `EncryptedFile` containing `key`, `iv`, `hashes`) instead of `url`. After downloading the encrypted blob via `mxc://` URL, we decrypt using the wasm SDK's media decryption:

The wasm SDK provides `Attachment.decrypt(encryptedAttachment)` as a static method. We construct an `EncryptedAttachment` from the event's `file` field:

```typescript
import { Attachment } from '@matrix-org/matrix-sdk-crypto-wasm'

const encryptedBuffer = await matrixClient.downloadContent(mxcUrl)
const decryptedBuffer = Attachment.decrypt(encryptedAttachment)
```

If the `EncryptedAttachment` constructor proves difficult to use from the event's `file` JSON, we fall back to implementing AES-CTR decryption using the `key`, `iv`, and `hashes` from the `EncryptedFile` spec via Node's `crypto` module — a straightforward ~20-line function per the Matrix spec.

### 9. Configuration & Access Control

**No changes to `access.json` schema.** Encryption is transparent — existing room policies and DM policies work the same regardless of whether a room is encrypted. The access gate runs after decryption.

**No `.env` additions.** E2EE is enabled automatically.

**Documentation updates:** README.md and ACCESS.md are updated to reflect E2EE support and point users to `/matrix:verify`.

## Files Changed

| File | Change |
|------|--------|
| `server.ts` | Replace bot-sdk crypto with wasm OlmMachine. Hook into sync for crypto data. Add encrypt/decrypt logic for room events. Add verification state checking in message handler. Add "unverified" notice logic. Update `fetch_messages` to decrypt. Update `download_attachment` for encrypted media. Remove `m.room.encrypted` warning handler. |
| `package.json` | Replace `@matrix-org/matrix-sdk-crypto-nodejs` with `@matrix-org/matrix-sdk-crypto-wasm@^18.0.0` |
| `skills/verify/SKILL.md` | New skill for interactive SAS verification from terminal |
| `README.md` | Update to reflect E2EE support |
| `ACCESS.md` | Remove "E2EE not supported" warnings, document verification flow |

## What Stays the Same

- Access gate logic (runs post-decryption)
- All existing MCP tools (reply, react, edit, fetch, download) — same interface, crypto is internal
- DM/room policies in `access.json`
- Pairing flow
- Permission relay
- `matrix-bot-sdk` for Matrix client operations (sync, room state, sending)

## Risk Areas

- **Bun + wasm compatibility:** The wasm package loads a `.wasm` binary via `initAsync()`. This needs validation under Bun — step 0 of implementation should be a smoke test confirming OlmMachine initializes, `store_name` persists to the filesystem, and basic encrypt/decrypt works.
- **Sync hook via subclassing:** We subclass `MatrixClient` and override the protected `processSync` method. This ties us to the bot-sdk's internal API — if they change `processSync`'s signature in a future version, our subclass breaks. Pin `matrix-bot-sdk` version to mitigate.
- **Crypto store corruption:** Could prevent the bot from starting. On initialization failure, log clearly and suggest deleting the crypto store (which triggers re-verification). Do not auto-delete.
- **Key backup:** Not included in this design. If the crypto store is lost, the bot gets a new device identity and must be re-verified.
- **Historical messages:** `fetch_messages` for messages sent before the bot joined an encrypted room will return `[unable to decrypt]`. This is inherent to E2EE.
- **MCP instructions string:** The existing instruction in `server.ts` (line ~375) that says "E2EE is not supported" must be updated to reflect the new behavior.
