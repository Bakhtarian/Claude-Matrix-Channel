---
name: configure
description: "Set up the Matrix channel — save the homeserver URL and access token, review access policy. Use when the user pastes Matrix credentials, asks to configure Matrix, asks 'how do I set this up' or 'who can reach me,' or wants to check channel status."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Glob
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /matrix:configure — Matrix Channel Setup

Writes credentials to `~/.claude/channels/matrix/.env` and orients the user
on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/matrix/.env` for
   `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN`. Show set/not-set;
   if set, show homeserver URL and first 6 chars of token masked.

2. **Runtime** — read the plugin `.mcp.json` (check `$CLAUDE_PLUGIN_ROOT/.mcp.json`,
   then `~/.claude/plugins/cache/matrix-channel/matrix/**/.mcp.json`,
   then `./.mcp.json`). Show the current `command` value (e.g. `bun`).
   Mention `/matrix:configure runtime <bun|npx-tsx|deno>` to change.

3. **Access** — read `~/.claude/channels/matrix/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list user IDs
   - Pending pairings: count, with codes and sender IDs if any
   - Rooms opted in: count

4. **What next** — end with a concrete next step based on state:
   - No credentials → *"Run `/matrix:configure <homeserver_url> <access_token>`
     with your bot's homeserver URL and access token."*
   - Credentials set, policy is pairing, nobody allowed → *"DM your bot on
     Matrix. It replies with a code; approve with `/matrix:access pair
     <code>`."*
   - Credentials set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** Once IDs are captured via pairing, switch
to `allowlist`:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. If yes and policy is still `pairing` → offer to run
   `/matrix:access policy allowlist`.
4. If no, people are missing → *"Have them DM the bot; you'll approve each
   with `/matrix:access pair <code>`."*

**E2EE Note:** E2EE is supported. Both encrypted and unencrypted rooms work.
By default the bot accepts messages from unverified devices. For stricter
security, set `requireVerifiedDevice` to `true` in `access.json` — then
device verification is required. Mention `/matrix:verify` for verification.

### `<homeserver_url> <access_token>` — save credentials

1. Parse: first arg is homeserver URL, second is access token.
2. `mkdir -p ~/.claude/channels/matrix`
3. Read existing `.env` if present; update/add both keys, preserve others.
4. Write back, no quotes around values.
5. `chmod 600 ~/.claude/channels/matrix/.env`
6. Confirm, then show the no-args status.

**How to get an access token:**
- Element: Settings → Help & About → Access Token (at the bottom)
- Or create a dedicated bot account and use the login API

### `runtime <bun|npx-tsx|deno>` — change the TypeScript runtime

Updates the `.mcp.json` in the plugin directory to use a different runtime.
The server needs a restart after changing.

Supported values and their `.mcp.json` mappings:

| Value | command | args |
|-------|---------|------|
| `bun` (default) | `bun` | `["server.ts"]` |
| `npx-tsx` | `npx` | `["tsx", "server.ts"]` |
| `deno` | `deno` | `["run", "--allow-all", "server.ts"]` |

Steps:
1. Find the plugin `.mcp.json`. Check these locations in order:
   - `$CLAUDE_PLUGIN_ROOT/.mcp.json` (if env var is set)
   - `~/.claude/plugins/cache/matrix-channel/matrix/**/.mcp.json`
   - `./.mcp.json` (development fallback)
2. Read the current `.mcp.json`, preserve the `cwd` field if present.
3. Update `command` and `args` per the table above.
4. Write back with the Write tool.
5. Confirm: *"Runtime changed to `<value>`. Restart the session for it to take effect."*

If the user passes an unrecognized value, list the supported options.

### `clear` — remove credentials

Delete the `MATRIX_HOMESERVER_URL=` and `MATRIX_ACCESS_TOKEN=` lines.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet.
- The server reads `.env` once at boot. Credential changes need a session
  restart. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/matrix:access` take effect immediately.
