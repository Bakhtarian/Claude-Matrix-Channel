# Claude Matrix Channel

Matrix (Element) messaging channel for Claude Code, implemented as an MCP server.

## Architecture

- **Runtime**: Bun (TypeScript, ESM)
- **Entry point**: `server.ts` — MCP server + Matrix bot
- **Crypto**: `crypto.ts` — E2EE via `@matrix-org/matrix-sdk-crypto-wasm` (OlmMachine)
- **Transport**: Stdio (MCP SDK)
- **Bot SDK**: `matrix-bot-sdk` for Matrix Client-Server API v3

## Key Files

| File | Purpose |
|------|---------|
| `server.ts` | MCP server, Matrix sync, message gating, tool handlers, permission relay |
| `crypto.ts` | OlmMachine lifecycle, encrypt/decrypt, sync integration, `CryptoMatrixClient` |
| `.mcp.json` | MCP server config — runs `bun server.ts` |
| `ACCESS.md` | Full access control schema and documentation |
| `.claude-plugin/plugin.json` | Plugin manifest (name: `matrix`) |
| `.claude-plugin/marketplace.json` | Marketplace registration for `/plugin install` |
| `skills/access/SKILL.md` | `/matrix:access` — manage allowlists, pairings, room policy |
| `skills/configure/SKILL.md` | `/matrix:configure` — save credentials, review status |
| `skills/verify/SKILL.md` | `/matrix:verify` — interactive SAS device verification |

## State Directory

All runtime state lives in `~/.claude/channels/matrix/` (override with `MATRIX_STATE_DIR`):

- `.env` — `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` (chmod 600)
- `access.json` — access control policy (re-read on every inbound message)
- `approved/` — pairing approval files (server polls every 5s)
- `bot-store/` — Matrix sync state
- `inbox/` — downloaded attachments

## Message Flow

1. Matrix event → `room.message` or `room.event` (encrypted)
2. Encrypted events: decrypt via OlmMachine → check shield color (must be 2/verified) → re-emit as `room.message`
3. `gate()` checks: own message? old? DM policy? room policy? mention? allowlist?
4. If delivered: typing indicator → ack reaction → emit `notifications/claude/channel`
5. Claude responds via `reply()` tool → chunk → encrypt if needed → send

## Access Control (`access.json`)

```json
{
  "version": 1,
  "dmPolicy": "pairing|allowlist|disabled",
  "allowFrom": ["@user:homeserver"],
  "rooms": { "!roomId:hs": { "requireMention": true, "allowFrom": [] } },
  "pending": { "<hex-code>": { "senderId": "...", "roomId": "...", "createdAt": 0, "expiresAt": 0 } },
  "mentionPatterns": ["regex"],
  "ackReaction": "👀",
  "textChunkLimit": 40000,
  "chunkMode": "newline",
  "msgType": "m.notice",
  "requireVerifiedDevice": false
}
```

## E2EE

- `CryptoMatrixClient` extends `MatrixClient`, feeds sync data to OlmMachine before base processing
- `encryptIfNeeded()` tracks room members, flushes `KeysQuery` via `processOutgoingRequests()`, claims missing sessions, shares room keys, then encrypts. Sharing strategy depends on `requireVerifiedDevice` in `access.json`: `true` uses `CollectStrategy.onlyTrustedDevices()`, `false` (default) uses `CollectStrategy.allDevices()`.
- `decryptRoomEvent()` returns shield color: 0=Red/unverified, 1=Grey/partial, 2=None/verified
- When `requireVerifiedDevice` is true, unverified devices get a one-time notice per room explaining how to verify. When false (default), messages from unverified devices are accepted.
- Verification uses SAS (emoji comparison) via `/matrix:verify` skill
- **Crypto store is in-memory** (`fake-indexeddb`): OlmMachine state is lost between restarts. One-time keys regenerate each run; `KeysUpload` handles "already exists" conflicts by retrying without OTKs.
- **Device ID** is fetched from the homeserver's `/whoami` endpoint at startup (not generated locally)
- **Wasm object ownership**: `@matrix-org/matrix-sdk-crypto-wasm` consumes `UserId` (and similar) objects when passed to OlmMachine methods. Never reuse a `UserId` instance across multiple calls — create fresh instances each time via a factory like `() => members.map(uid => new UserId(uid))`.

## Skills (SKILL.md frontmatter)

Skills use `user-invocable: true` (hyphen, not underscore). They are registered via the `.claude-plugin/` directory and installed with:

```
/plugin marketplace add Bakhtarian/Claude-Matrix-Channel
/plugin install matrix@matrix-channel
```

## Common Issues

**Bot doesn't respond in a room**: Check `access.json` — is the sender in `allowFrom`? Is the room in `rooms`? If `requireMention` is true, the bot must be @mentioned.

**Encrypted room messages not delivered**: The bot's device must be verified. Shield color must be 2. Run `/matrix:verify` or verify from Element (bot profile → Sessions → Verify).

**"Failed to reconnect to matrix"**: Check `~/.claude/channels/matrix/.env` — homeserver URL and access token must be valid.

**"One time key already exists"**: Expected on restart since the crypto store is in-memory. The `KeysUpload` handler retries without OTKs automatically. Device keys still upload successfully.

**"array contains a value of the wrong type"**: Wasm `UserId`/`RoomId` objects were reused after being consumed. Each OlmMachine method call takes ownership of these objects — create fresh instances for each call.

**Skills not found after install**: Ensure `user-invocable: true` uses a hyphen. Run `/reload-plugins` after installing.

**Type errors**: Run `bunx tsc --noEmit` to check. The project uses strict TypeScript.

**Creating a new bot account**: Registration is typically disabled on homeservers. Use SSH and Synapse admin tools inside the Docker container, or the admin API with an admin-level access token.

## Development

```sh
bun install                    # install deps
bunx tsc --noEmit              # type check
bun server.ts                  # run server directly
```

Launch with Claude Code:
```sh
claude --dangerously-load-development-channels server:matrix
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_HOMESERVER_URL` | Yes | Matrix homeserver (e.g. `https://matrix.example.com`) |
| `MATRIX_ACCESS_TOKEN` | Yes | Bot account access token |
| `MATRIX_STATE_DIR` | No | Override state directory (for multi-agent) |
| `MATRIX_ACCESS_MODE` | No | Set to `static` to pin access.json at boot |
