# Matrix — Access & Delivery

Matrix rooms have no built-in bot gating — any account can be invited to any room. The first line of defense is keeping the bot account's credentials private. The second is the sender allowlist enforced by this channel.

For DMs, the default policy is **pairing**. An unknown sender gets a 6-character code in reply and their message is dropped. You run `/matrix:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/matrix/access.json`. The `/matrix:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `MATRIX_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Matrix user ID (e.g. `@alice:matrix.org`) |
| Room key | Room ID (e.g. `!abc123:matrix.org`) |
| Config file | `~/.claude/channels/matrix/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/matrix:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Use this once everyone who needs access is already on the list. |
| `disabled` | Drop everything, including allowlisted users and room messages. |

```
/matrix:access policy allowlist
```

## User IDs

Matrix identifies users by **user IDs**: permanent strings like `@alice:matrix.org`. These are set at registration and cannot be changed. The allowlist stores user IDs.

Pairing captures the ID automatically. To add someone manually:

```
/matrix:access allow @alice:matrix.org
/matrix:access remove @alice:matrix.org
```

## DM detection

Matrix has no native "DM" concept — DMs are rooms with two members. This channel detects DMs by:

1. Checking the `m.direct` account data (primary — what Element uses)
2. Falling back to room member count (exactly 2 joined members)

## Rooms

Rooms are off by default. Opt each one in individually by room ID. Find room IDs in Element: **Room Settings → Advanced → Internal room ID**.

```
/matrix:access room add !abc123:matrix.org
```

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message, or `--allow id1,id2` to restrict which members can trigger it.

```
/matrix:access room add !abc123:matrix.org --no-mention
/matrix:access room add !abc123:matrix.org --allow @alice:matrix.org,@bob:matrix.org
/matrix:access room rm !abc123:matrix.org
```

## Mention detection

In rooms with `requireMention: true`, any of the following triggers the bot:

- The bot's user ID appears in the message body
- The message uses `m.mentions` with the bot's user ID
- A reply to one of the bot's recent messages
- A match against any regex in `mentionPatterns`

```
/matrix:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/matrix:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. Unicode emoji only. Empty string disables.

```
/matrix:access set ackReaction 👀
/matrix:access set ackReaction ""
```

**`textChunkLimit`** sets the split threshold. Default 40000. Matrix has no hard limit, but very long messages degrade client rendering.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

**`msgType`** controls whether the bot sends `m.notice` (default, conventional for bots) or `m.text` (appears like a normal user message).

```
/matrix:access set msgType m.text
```

## Skill reference

| Command | Effect |
| --- | --- |
| `/matrix:access` | Print current state: policy, allowlist, pending pairings, enabled rooms. |
| `/matrix:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Matrix. |
| `/matrix:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/matrix:access allow @user:matrix.org` | Add a user ID directly. |
| `/matrix:access remove @user:matrix.org` | Remove from the allowlist. |
| `/matrix:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/matrix:access room add !room:matrix.org` | Enable a room. Flags: `--no-mention`, `--allow id1,id2`. |
| `/matrix:access room rm !room:matrix.org` | Disable a room. |
| `/matrix:access set ackReaction 👀` | Set a config key. |

## Config file

`~/.claude/channels/matrix/access.json`. Absent file is equivalent to `pairing` policy with empty lists.

```jsonc
{
  // Schema version for future migrations.
  "version": 1,

  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Matrix user IDs allowed to DM.
  "allowFrom": ["@alice:matrix.org"],

  // Rooms the bot is active in. Empty object = DM-only.
  "rooms": {
    "!abc123:matrix.org": {
      // true: respond only to @mentions and replies.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member.
      "allowFrom": []
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Reaction on receipt. Empty string disables.
  "ackReaction": "👀",

  // Split threshold for long messages.
  "textChunkLimit": 40000,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline",

  // m.notice (default, bot convention) or m.text (normal messages).
  "msgType": "m.notice"
}
```

## Encryption

**E2EE is not supported.** The bot cannot read messages in encrypted rooms. Element defaults to encrypting DMs, so you must create an unencrypted room:

1. In Element: **Create new room** → toggle off **"Enable end-to-end encryption"**
2. Invite your bot account to the room
3. Start a conversation

Future versions may add E2EE support via `@matrix-org/matrix-sdk-crypto-nodejs`.
