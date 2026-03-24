# Matrix Channel for Claude Code

Connect a Matrix bot to your Claude Code session with an MCP server.

When the bot receives a message, the MCP server forwards it to Claude and provides tools to reply, react, edit messages, fetch history, and download attachments.

## Prerequisites

- [Bun](https://bun.sh) (default) or another TypeScript runtime (see [Alternative Runtimes](#alternative-runtimes))
- A Matrix homeserver you have access to (e.g. your own Synapse instance, or matrix.org)
- A dedicated Matrix account for the bot

## End-to-End Encryption

E2EE is supported. The bot works in both encrypted and unencrypted rooms.

By default, the bot encrypts for **all** devices in the room and accepts messages from unverified devices. To require device verification (stricter security), set `"requireVerifiedDevice": true` in `access.json`.

**To verify the bot's device (optional, or required if `requireVerifiedDevice` is enabled):**
- From Element: Go to the bot user's profile → Sessions → Click the bot's device → Verify
- From the terminal: Run `/matrix:verify` to interactively verify devices
- To locally trust all devices for a user without SAS: use the `verify_device` tool with action `trust`

## Quick Setup

### 1. Create a Matrix account for the bot

Register a new account on your homeserver for the bot. If your homeserver has open registration disabled (most do), you'll need admin access.

**With Synapse admin access (SSH to your server):**

```sh
docker exec synapse register_new_matrix_user \
  -u mybotname \
  -p 'a-strong-password-here' \
  --no-admin \
  -c /data/homeserver.yaml \
  http://localhost:8008
```

**With open registration enabled**, use any Matrix client (Element, etc.) to register a new account.

### 2. Get the access token

Log in with the bot account to get an access token:

```sh
curl -X POST "https://your-homeserver/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"mybotname","password":"a-strong-password-here"}'
```

The response includes `access_token` — save it, you'll need it in step 4.

### 3. Clone and install

```sh
git clone https://github.com/Bakhtarian/Claude-Matrix-Channel.git
cd Claude-Matrix-Channel
bun install
```

### 4. Install the Claude Code plugin

Register the marketplace and install the plugin to get the `/matrix:access`, `/matrix:configure`, and `/matrix:verify` skills:

```
/plugin marketplace add Bakhtarian/Claude-Matrix-Channel
/plugin install matrix@matrix-channel
```

### 5. Configure credentials

Create the credentials file:

```sh
mkdir -p ~/.claude/channels/matrix
cat > ~/.claude/channels/matrix/.env << 'EOF'
MATRIX_HOMESERVER_URL=https://your-homeserver
MATRIX_ACCESS_TOKEN=syt_your_access_token_here
EOF
chmod 600 ~/.claude/channels/matrix/.env
```

Replace `https://your-homeserver` and the access token with your actual values from steps 1-2.

### 6. Create a room and invite the bot

Create a room and invite the bot. Both encrypted and unencrypted rooms work. For encrypted rooms, you'll need to verify the bot's device after setup (see "End-to-End Encryption" above).

**Using the Matrix API** (replace the homeserver URL and your access token):

```sh
# Create the room (using YOUR personal access token, not the bot's)
curl -X POST "https://your-homeserver/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer YOUR_PERSONAL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude Bot",
    "preset": "public_chat",
    "visibility": "private"
  }'
```

This returns a `room_id` (e.g. `!abc123:your-homeserver`). Then invite the bot:

```sh
curl -X POST "https://your-homeserver/_matrix/client/v3/rooms/ROOM_ID/invite" \
  -H "Authorization: Bearer YOUR_PERSONAL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"@mybotname:your-homeserver"}'
```

The bot will auto-join when the server starts. You can also create the room using Element (make sure to disable encryption) and invite the bot from the UI.

**Using Element:**
1. Click **+** → **New Room**
2. Name it whatever you like
3. **Disable** "Enable end-to-end encryption"
4. Create the room
5. Invite `@mybotname:your-homeserver`

### 7. Configure access control

Create the access control file. Replace the user ID and room ID with your actual values:

```sh
cat > ~/.claude/channels/matrix/access.json << 'EOF'
{
  "version": 1,
  "dmPolicy": "pairing",
  "allowFrom": ["@youruser:your-homeserver"],
  "rooms": {
    "!your-room-id:your-homeserver": {
      "requireMention": false,
      "allowFrom": []
    }
  },
  "pending": {},
  "requireVerifiedDevice": false
}
EOF
```

- `allowFrom`: your Matrix user ID (the account you'll message from)
- `requireVerifiedDevice`: set to `true` to only accept messages from verified devices (default: `false`)
- `rooms`: the room ID from step 5. Set `requireMention: false` if you want the bot to respond to every message, or `true` to only respond when @mentioned.

To find your room ID in Element: **Room Settings → Advanced → Internal room ID**.

### 8. Launch Claude Code with the channel

From the `claude-matrix-channel` directory:

```sh
cd /path/to/claude-matrix-channel
claude --dangerously-load-development-channels server:matrix
```

You should see the channel connect in the startup output. Send a message in the room — Claude will receive it and respond.

## Access Control

See **[ACCESS.md](./ACCESS.md)** for the full access control documentation including:

- DM policies (pairing, allowlist, disabled)
- Room-level policies and mention detection
- Delivery configuration (reactions, chunking, message type)
- The complete `access.json` schema

### Quick Reference

Edit `~/.claude/channels/matrix/access.json` directly — the server re-reads it on every inbound message, so changes take effect immediately without a restart.

**Add a user to the allowlist:**
```json
"allowFrom": ["@alice:your-homeserver", "@bob:your-homeserver"]
```

**Add a room:**
```json
"rooms": {
  "!roomid:your-homeserver": {
    "requireMention": true,
    "allowFrom": []
  }
}
```

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a room. Takes `room_id` + `text`, optionally `html` for formatted content, `reply_to` (event ID) for threading, and `files` (absolute paths) for attachments. Auto-chunks long messages. Returns the sent event ID(s). |
| `react` | Add an emoji reaction to any message by ID. |
| `edit_message` | Edit a message the bot previously sent. Useful for progress updates. |
| `fetch_messages` | Pull recent history from a room (oldest-first, max 100). Each line includes the event ID. |
| `download_attachment` | Download media from a specific message to `~/.claude/channels/matrix/inbox/`. Returns file path + metadata. |
| `verify_device` | Manage E2EE device verification. Actions: `status`, `initiate`, `accept`, `confirm`, `cancel`, `trust`. Used by `/matrix:verify` for SAS emoji verification. |

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
MATRIX_STATE_DIR=~/.claude/channels/matrix-agent2 claude \
  --dangerously-load-development-channels server:matrix
```

Each instance gets independent: access.json, .env (same or different bot
accounts), inbox, sync storage.

## Alternative Runtimes

The server defaults to Bun but can run on other TypeScript runtimes. The easiest way to switch is:

```
/matrix:configure runtime npx-tsx
```

Supported values: `bun` (default), `npx-tsx`, `deno`. This updates the plugin's `.mcp.json` automatically.

You can also edit `.mcp.json` manually:

**Using `npx tsx`:**
```json
{
  "mcpServers": {
    "matrix": {
      "command": "npx",
      "args": ["tsx", "server.ts"]
    }
  }
}
```

**Using Deno:**
```json
{
  "mcpServers": {
    "matrix": {
      "command": "deno",
      "args": ["run", "--allow-all", "server.ts"]
    }
  }
}
```

You can also set `MATRIX_RUNTIME` in your shell and use the npm start script: `MATRIX_RUNTIME=npx tsx npm start`.

## Troubleshooting

**"no MCP server configured with that name"** — Make sure you're running `claude` from the `claude-matrix-channel` directory so it can find the `.mcp.json` file.

**"Failed to reconnect to matrix"** — Check your credentials in `~/.claude/channels/matrix/.env`. Verify the homeserver URL is correct and the access token is valid.

**Bot doesn't respond to messages** — Check that:
1. If the room is encrypted, verify the bot's device (see "End-to-End Encryption")
2. Your user ID is in the `allowFrom` list in `access.json`
3. The room ID is in the `rooms` section of `access.json`
4. If `requireMention` is `true`, you need to @mention the bot

**"unverified" notice in an encrypted room** — This only appears when `requireVerifiedDevice` is `true` in `access.json`. Either verify the bot's device (Element or `/matrix:verify`), or set `"requireVerifiedDevice": false` to accept messages from unverified devices.

**"array contains a value of the wrong type"** — This is a wasm ownership error in `@matrix-org/matrix-sdk-crypto-wasm`. The `UserId` objects passed to OlmMachine methods are consumed (freed) by each call. If you see this, ensure fresh `UserId` instances are created for each wasm method call rather than reusing objects.
