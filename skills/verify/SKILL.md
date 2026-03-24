---
name: verify
description: "Interactively verify a Matrix device using SAS emoji comparison for E2EE. Lists pending verification requests or initiates one."
user-invocable: true
allowed-tools:
  - Read
  - mcp__matrix__verify_device
arguments: "user-to-verify"
---

# Matrix Device Verification

Interactive SAS emoji verification for E2EE rooms.

Arguments passed: `$ARGUMENTS`

## How to verify

Use the `verify_device` MCP tool to drive the verification flow.

### Step 1 — Check status

Call `verify_device` with action `status` to see the bot's device ID, fingerprint, and any pending verification requests.

If no pending requests:
- Tell the user to initiate verification from Element: go to the bot's profile, click Sessions, find the bot's device, and click Verify.
- Then check status again to pick up the request.

### Step 2 — Accept and start SAS

If `$ARGUMENTS` contains a user ID, or status shows a pending request:

Call `verify_device` with action `accept` and the `user_id` of the other party. This accepts the request and starts the SAS emoji exchange.

### Step 3 — Show emoji

Call `verify_device` with action `status` to see the 7 SAS emoji. Display them clearly and ask the user to confirm they match what Element shows.

### Step 4 — Confirm or cancel

- If the user confirms the emoji match: call `verify_device` with action `confirm`.
- If they don't match: call `verify_device` with action `cancel`.

### Step 5 — Done

After confirmation, the device is trusted. Encrypted messages will now be delivered from that user's verified devices.

## Notes

- Verification requests time out after about 10 minutes.
- The user must start verification from Element before we can accept it.
- After verification, the OlmMachine marks the device as trusted automatically.
