# Matrix

Connect a Matrix bot to your Claude Code session with an MCP server.

When the bot receives a message, the MCP server forwards it to Claude and provides tools to reply, react, edit messages, fetch history, and download attachments.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Important: No E2EE Support

This channel does **not** support end-to-end encrypted rooms. Element defaults to encrypting DMs, so you must create an **unencrypted** room for the bot:

- In Element: **Create new room** → toggle off **"Enable end-to-end encryption"**
- Or invite the bot to an existing unencrypted room

## Quick Setup

> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for rooms and multi-user setups.

**1. Create a Matrix account for your bot.**

Register a new account on your homeserver (e.g. matrix.org) for the bot. You can use Element or any Matrix client to register.

**2. Get the access token.**

In Element: **Settings → Help & About → Access Token** (scroll to the bottom). Copy it — treat it like a password.

Alternatively, use the Matrix login API:

```sh
curl -X POST "https://matrix.org/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"@botname:matrix.org","password":"..."}'
```

The response includes `access_token`.

**3. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

```
/plugin install matrix@claude-plugins-official
```

Or if running from source:
```
/plugin install /path/to/claude-matrix-channel
```

**4. Give the server the credentials.**

```
/matrix:configure https://matrix.org syt_your_access_token_here
```

Writes `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` to `~/.claude/channels/matrix/.env`. You can also write that file by hand, or set the variables in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `MATRIX_STATE_DIR` at a different directory per instance.

**5. Relaunch with the channel flag.**

Exit your session and start a new one:

```sh
claude --channels plugin:matrix@claude-plugins-official
```

Or from source:
```sh
claude --dangerously-load-development-channels server:matrix
```

**6. Pair.**

With Claude Code running, DM your bot on Matrix (in an **unencrypted** room) — it replies with a pairing code. In your Claude Code session:

```
/matrix:access pair <code>
```

Your next DM reaches the assistant.

**7. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist`:

```
/matrix:access policy allowlist
```

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, room support, mention detection, delivery config, and the `access.json` schema.

Quick reference: IDs are Matrix user IDs (`@user:homeserver`). Default policy is `pairing`. Rooms are opt-in per room ID.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a room. Takes `room_id` + `text`, optionally `html` for formatted content, `reply_to` (event ID) for threading, and `files` (absolute paths) for attachments. Auto-chunks long messages. Returns the sent event ID(s). |
| `react` | Add an emoji reaction to any message by ID. |
| `edit_message` | Edit a message the bot previously sent. Useful for progress updates. |
| `fetch_messages` | Pull recent history from a room (oldest-first, max 100). Each line includes the event ID. |
| `download_attachment` | Download media from a specific message to `~/.claude/channels/matrix/inbox/`. Returns file path + metadata. |

Inbound messages trigger a typing indicator automatically — Element shows
"botname is typing…" while the assistant works on a response.

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(room_id, event_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/matrix/inbox/`.

## Multi-Agent Setup

Each Claude Code session runs its own Matrix channel instance. To connect
multiple agents, set `MATRIX_STATE_DIR` to a different directory per instance:

```sh
MATRIX_STATE_DIR=~/.claude/channels/matrix-agent2 claude --channels ...
```

Each instance gets independent: access.json, .env (same or different bot
accounts), inbox, sync storage.
