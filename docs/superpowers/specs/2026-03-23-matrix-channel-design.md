# Matrix Channel for Claude Code — Design Spec

## Overview

A Claude Code channel plugin that bridges Matrix (Element) messaging into a running Claude Code session. Built as an MCP server following the same architecture as the official Telegram and Discord channel plugins.

## Architecture

```
Matrix Homeserver (via matrix-bot-sdk sync loop)
        |
        v
Channel Server (MCP server, spawned by Claude Code as subprocess)
        | (stdio transport - stdin/stdout)
        v
Claude Code Session (local, full filesystem/git/MCP access)
```

The server is a single `server.ts` file that:
1. Connects to a Matrix homeserver using `matrix-bot-sdk`
2. Listens for `m.room.message` events via the sync loop
3. Gates messages through sender allowlist / pairing
4. Pushes approved messages into Claude via `notifications/claude/channel`
5. Exposes MCP tools for Claude to reply, react, edit, fetch history, and download attachments

## Technology

- **Runtime:** Bun
- **Language:** TypeScript
- **Matrix library:** `matrix-bot-sdk` — lightweight, well-maintained, standard for Matrix bots
- **MCP SDK:** `@modelcontextprotocol/sdk`

## File Structure

```
claude-matrix-channel/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata
├── skills/
│   ├── access/
│   │   └── SKILL.md         # Access management skill
│   └── configure/
│       └── SKILL.md         # Setup/token configuration skill
├── .mcp.json                # MCP server config
├── .npmrc                   # Registry config
├── ACCESS.md                # Access control documentation
├── README.md                # Setup guide
├── LICENSE                  # Apache 2.0
├── package.json             # Dependencies
├── tsconfig.json            # TypeScript configuration
└── server.ts                # Main MCP server
```

## State Directory

`~/.claude/channels/matrix/` (override with `MATRIX_STATE_DIR` env var for multi-agent setups)

```
~/.claude/channels/matrix/
├── .env                     # MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN
├── access.json              # Sender allowlist, room policies, pending pairings
├── approved/                # Pairing approval signals (polled by server)
├── inbox/                   # Downloaded attachments
└── bot-store/               # matrix-bot-sdk sync/crypto storage
```

## Access Control

Mirrors the Discord/Telegram model exactly.

### Sender Identity

Matrix user IDs: `@username:homeserver.tld` — permanent, unique, unforgeable by other users.

### DM Policy

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Reply with 6-char code, drop message. Approve with `/matrix:access pair <code>`. |
| `allowlist` | Drop silently. |
| `disabled` | Drop everything. |

### Room Support

Opt-in per room ID (`!roomid:homeserver`). Each room entry has:
- `requireMention` (default `true`) — only respond when @mentioned or replied to
- `allowFrom` — restrict which senders trigger the bot in that room. Empty array `[]` means no restriction (any room member can trigger, subject to `requireMention`).

### access.json Schema

```json
{
  "version": 1,
  "dmPolicy": "pairing",
  "allowFrom": ["@alice:matrix.org"],
  "rooms": {
    "!abc123:matrix.org": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "pending": {
    "a4f91c": {
      "senderId": "@bob:matrix.org",
      "roomId": "!dm:matrix.org",
      "createdAt": 1711200000000,
      "expiresAt": 1711203600000,
      "replies": 1
    }
  },
  "mentionPatterns": [],
  "ackReaction": "",
  "textChunkLimit": 40000,
  "chunkMode": "newline",
  "msgType": "m.notice"
}
```

## MCP Tools

### `reply`

Send a message to a Matrix room.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `room_id` | string | yes | Room ID from inbound `<channel>` tag |
| `text` | string | yes | Message body (plain text) |
| `html` | string | no | Optional HTML-formatted body |
| `reply_to` | string | no | Event ID to thread under |
| `files` | string[] | no | Absolute file paths to upload as attachments |

Auto-chunks long messages. Matrix has no hard message limit like Discord's 2000 chars, but very long messages degrade UX — default chunk at 40000 chars. Files are uploaded via Matrix content repository (`mxc://` URIs) and sent as `m.file`/`m.image` messages.

### `react`

Add an emoji reaction to a message.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `room_id` | string | yes | Room ID |
| `event_id` | string | yes | Event ID to react to |
| `emoji` | string | yes | Unicode emoji |

Sends `m.reaction` event with `m.relates_to` of type `m.annotation`.

### `edit_message`

Edit a previously sent message.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `room_id` | string | yes | Room ID |
| `event_id` | string | yes | Event ID of bot's message |
| `text` | string | yes | New message body |
| `html` | string | no | Optional new HTML body |

Sends replacement event with `m.relates_to` of type `m.replace`.

### `fetch_messages`

Fetch recent messages from a room.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `room_id` | string | yes | Room ID |
| `limit` | number | no | Max messages (default 20, max 100) |

Returns oldest-first with event IDs, timestamps, sender, and attachment indicators.

### `download_attachment`

Download media from a specific message.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `room_id` | string | yes | Room ID |
| `event_id` | string | yes | Event ID of message with attachment |

Downloads `mxc://` content to `inbox/` directory. Returns local file paths.

## Inbound Message Flow

1. `matrix-bot-sdk` sync loop receives `m.room.message` event
2. Skip if sender is the bot itself
3. Determine if DM or room message
4. Run through gate (check allowlist / pairing / room policy / mention)
5. If `pair`: reply with pairing code in Matrix, drop the message
6. If `drop`: silently ignore
7. If `deliver`: emit MCP notification

```xml
<channel source="matrix" room_id="!abc:matrix.org" event_id="$evt123" user="@alice:matrix.org" ts="2026-03-23T10:00:00Z">
Hello Claude, can you check the build?
</channel>
```

For messages with attachments, include `attachment_count` and `attachments` in meta (name/type/size), same as Discord. Don't auto-download.

## Permission Relay

Declares `claude/channel/permission: {}` capability. When Claude needs tool approval:

1. Claude Code sends `notifications/claude/channel/permission_request` with `request_id` (5 lowercase letters, excluding 'l'), `tool_name`, `description`, `input_preview`
2. Server sends the permission prompt to the room where the triggering message originated (tracked per-session)
3. User replies with `y <code>` or `n <code>`
4. Server parses verdict regex `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` — only from allowlisted senders
5. Server sends `notifications/claude/channel/permission` back with `request_id` and `behavior`

Note: Pairing codes are 6-char hex strings (e.g. `a4f91c`). Permission request IDs are 5 lowercase letters (excluding 'l'). These are distinct code formats for distinct flows.

## DM Detection

Matrix doesn't have a native "DM" concept — DMs are just rooms with two members. Detection uses a layered approach:

1. **Primary:** Check `m.direct` account data — this is what Element uses to mark DMs, most reliable
2. **Fallback:** Check if room has exactly 2 joined members (bot + sender)

This handles edge cases where `m.direct` is set but a third user was invited, or where bridge bots add members to DM rooms.

## Encryption (E2EE)

**E2EE is not supported in the initial version.** Matrix rooms encrypted with Megolm (`m.megolm.v1.aes-sha2`) will not work — the bot cannot decrypt messages in encrypted rooms.

This is an intentional limitation:
- E2EE support requires `libolm` native bindings, key management, device verification, and significant complexity
- Element defaults to encrypting DMs, so users must **create an unencrypted room** for the bot

The bot will detect encrypted rooms and log a warning. The `/matrix:configure` skill will document how to create an unencrypted DM room.

Future: E2EE support can be added via `matrix-bot-sdk`'s `@matrix-org/matrix-sdk-crypto-nodejs` integration.

## Sync Startup Behavior

On startup (or restart), the sync loop may replay events that occurred while the bot was offline. To prevent flooding the Claude session with stale messages:

1. Record a `startupTimestamp` when the server boots
2. During initial sync, **drop all events with origin_server_ts before startupTimestamp**
3. Only deliver events received in real-time after the initial sync completes
4. The `matrix-bot-sdk` `AutojoinRoomsMixin` is NOT used — room joins are manual via `/matrix:access`

## Bot Message Type

Bot replies use `m.notice` msgtype (not `m.text`). This is Matrix convention for automated/bot messages — clients render them differently and users can filter them. Configurable via `msgType` in access.json (`m.notice` or `m.text`).

## Typing Indicators

The server sends `m.typing` events when a message is delivered to Claude, providing visual feedback that the bot is processing. The typing indicator is set when the notification is emitted and cleared when the reply tool is called.

## Multi-Agent Support

`MATRIX_STATE_DIR` env var overrides the default `~/.claude/channels/matrix/`. Each Claude Code instance can run its own Matrix channel with separate state:

```sh
MATRIX_STATE_DIR=~/.claude/channels/matrix-agent2 claude --channels ...
```

Each instance gets independent: access.json, .env (can use same or different bot accounts), inbox, sync storage.

## Security

- Gate on sender identity (`@user:homeserver`), not room identity
- Never approve pairings from channel messages (prompt injection defense)
- `assertSendable()` blocks sending files from state directory (except inbox)
- Token stored with `chmod 600`
- Atomic writes for access.json (write to .tmp, rename)
- Sanitize attachment names in notifications

## Skills

### `/matrix:configure`

- No args: show status (token set/not-set, access policy, allowed senders)
- `<homeserver_url> <access_token>`: save to `.env`
- `clear`: remove credentials

### `/matrix:access`

- No args: show current state
- `pair <code>`: approve pairing
- `deny <code>`: reject pairing
- `allow <user_id>`: add to allowlist
- `remove <user_id>`: remove from allowlist
- `policy <mode>`: set DM policy
- `room add <room_id>` (flags: `--no-mention`, `--allow id1,id2`): enable a room
- `room rm <room_id>`: disable a room
- `set <key> <value>`: configure delivery settings
