---
name: verify
description: Interactively verify a Matrix device using SAS (emoji comparison) for E2EE. Lists pending verification requests or initiates one.
user-invocable: true
arguments: "[optional @user:server to verify]"
---

# Matrix Device Verification

Interactive SAS (Short Authentication String) verification for E2EE.

## What This Does

Establishes cryptographic trust between the bot's device and another user's device so that encrypted messages can be exchanged. Both sides compare a set of 7 emoji — if they match, the devices are mutually verified.

## Steps

1. **Check for pending verification requests** — call `getOlmMachine()` from `crypto.ts`, then `machine.getVerificationRequests(userId)` for known users. List any pending requests with their user ID, device ID, and time remaining.

2. **If no pending requests and no argument given** — show the bot's device ID and Ed25519 key fingerprint. Instruct the user to initiate verification from Element: Settings → Sessions → find the bot's device → Verify.

3. **If a @user:server argument is given** — initiate verification toward that user:
   - Call `machine.getDevice(new UserId(userId), new DeviceId(deviceId))` to find their device
   - Call `device.requestVerification([VerificationMethod.SasV1])` to start
   - Send the resulting ToDeviceRequest via `sendCryptoRequest`

4. **Accept and start SAS** — once a request is ready:
   - Call `request.acceptWithMethods([VerificationMethod.SasV1])`
   - Send the resulting OutgoingVerificationRequest
   - Call `request.startSas()` → returns `[Sas, OutgoingVerificationRequest]`
   - Send the SAS outgoing request
   - If we are the acceptor (not initiator), also call `sas.accept()` and send that

5. **Display emoji** — poll `sas.canBePresented()`, then call `sas.emoji()` to get 7 Emoji objects with `symbol` and `description` fields. Display clearly:

   ```
   Verify these emoji match what you see in Element:

   🐶 Dog  |  🔑 Key  |  🎩 Hat  |  📌 Pin  |  🎧 Headphones  |  ✂️ Scissors  |  🔔 Bell

   Do they match? (yes/no)
   ```

6. **Confirm or cancel** — if user confirms, call `sas.confirm()` and send resulting requests. If denied, call `sas.cancel()`.

7. **Process remaining outgoing requests** after confirmation to complete verification.

## Important Notes

- Verification requests time out (typically 10 minutes). Show `request.timeRemainingMillis()`.
- After verification completes, the OlmMachine marks the device as trusted automatically.
- The skill imports from `crypto.ts` — use `getOlmMachine()`, `processOutgoingRequests()`, and `sendCryptoRequest()`.
- Use `VerificationMethod.SasV1` from `@matrix-org/matrix-sdk-crypto-wasm`.
- After all SAS steps, call `processOutgoingRequests(matrixClient)` to flush any remaining crypto requests.
