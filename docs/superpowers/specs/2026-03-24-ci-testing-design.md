# CI, Testing & Static Analysis

## Summary

Add GitHub Actions CI, Biome for linting/formatting, and Bun-based unit tests to the claude-matrix-channel project.

## Architecture

### GitHub Actions Workflow (`.github/workflows/ci.yml`)

Single workflow triggered on push and PR to `master`:

1. **Type check** — `bunx tsc --noEmit`
2. **Lint & format** — `bunx biome check .`
3. **Test** — `bun test`

Runs on `ubuntu-latest` with Bun installed via `oven-sh/setup-bun`.

### Biome (`biome.json`)

All-in-one linter and formatter. Config:
- Match current code style (tabs or spaces, line width)
- Ignore `node_modules/`, `dist/`, `docs/`
- Enable recommended lint rules

### Extracting testable logic (`lib.ts`)

Currently all logic lives in `server.ts` as unexported functions. Extract pure/near-pure functions into `lib.ts` so both `server.ts` and tests can import them:

| Function | Notes |
|----------|-------|
| `chunk()` | Fully pure text splitting |
| `defaultAccess()` | Pure defaults factory |
| `pruneExpired()` | Near-pure, mutates input + Date.now() |
| `isMentioned()` | Needs userId + content, no network calls if extracted properly |
| `gate()` decision logic | Extract the policy-evaluation part, pass access + context as args instead of reading from disk |

The extracted `gate` logic should be a pure function that takes `(access, senderId, isDM, roomId, isMentioned)` and returns the action — no I/O. `server.ts` keeps the wiring (loading access, checking DM status, calling the pure function).

### Tests (`lib.test.ts`)

Using Bun's built-in test runner (`bun:test`). Test cases:

**`chunk()`**:
- Text shorter than limit returns single element
- Length mode cuts at exact limit
- Newline mode prefers paragraph breaks, then line breaks, then spaces
- Empty string / edge cases

**`defaultAccess()`**:
- Returns correct shape with expected defaults

**`pruneExpired()`**:
- Removes expired entries, keeps valid ones
- Returns `true` when entries were removed, `false` otherwise

**`isMentioned()`** (extracted as pure function taking userId, content, extraPatterns):
- Matches userId in body
- Matches userId in formatted_body
- Matches m.mentions spec
- Matches extra regex patterns
- Returns false when no match

**`gate()` pure logic** (extracted decision function):
- Disabled policy drops all
- DM from allowed sender delivers
- DM from unknown sender in pairing mode returns pair action
- DM from unknown sender in allowlist mode drops
- Room message without room policy drops
- Room message with requireMention=true and no mention drops
- Room message with requireMention=false delivers
- Room-level allowFrom filtering

## What's NOT tested

- Matrix client interactions (sync, send, receive)
- E2EE (OlmMachine, encryption, decryption)
- MCP transport
- File I/O (readAccessFile, saveAccess)

These require a live homeserver or extensive mocking that would be brittle. The CI type check catches structural issues in these areas.

## Package changes

```json
{
  "devDependencies": {
    "bun-types": "^1.3.11",
    "@biomejs/biome": "^1.9.0"
  },
  "scripts": {
    "start": "${MATRIX_RUNTIME:-bun} server.ts",
    "check": "bunx tsc --noEmit && bunx biome check .",
    "test": "bun test",
    "format": "bunx biome check --write ."
  }
}
```
