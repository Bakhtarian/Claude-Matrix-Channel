import { describe, expect, test } from 'bun:test'
import { type Access, checkMention, chunk, defaultAccess, evaluateGate, pruneExpired } from './lib'

// ---------------------------------------------------------------------------
// defaultAccess
// ---------------------------------------------------------------------------
describe('defaultAccess', () => {
  test('returns correct shape with expected defaults', () => {
    const a = defaultAccess()
    expect(a.version).toBe(1)
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual([])
    expect(a.rooms).toEqual({})
    expect(a.pending).toEqual({})
  })

  test('returns a fresh object each call', () => {
    const a = defaultAccess()
    const b = defaultAccess()
    expect(a).not.toBe(b)
    a.allowFrom.push('@test:example.com')
    expect(b.allowFrom).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// pruneExpired
// ---------------------------------------------------------------------------
describe('pruneExpired', () => {
  test('removes expired entries', () => {
    const a = defaultAccess()
    a.pending.abc = { senderId: '@a:x', roomId: '!r:x', createdAt: 0, expiresAt: 100, replies: 1 }
    a.pending.def = { senderId: '@b:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 1 }

    const changed = pruneExpired(a, 200)
    expect(changed).toBe(true)
    expect(a.pending.abc).toBeUndefined()
    expect(a.pending.def).toBeDefined()
  })

  test('returns false when nothing expired', () => {
    const a = defaultAccess()
    a.pending.abc = { senderId: '@a:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 1 }

    const changed = pruneExpired(a, 200)
    expect(changed).toBe(false)
    expect(a.pending.abc).toBeDefined()
  })

  test('handles empty pending', () => {
    const a = defaultAccess()
    expect(pruneExpired(a, 200)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------
describe('chunk', () => {
  test('returns single element when text fits within limit', () => {
    expect(chunk('hello', 10, 'length')).toEqual(['hello'])
  })

  test('returns single element when text equals limit', () => {
    expect(chunk('12345', 5, 'length')).toEqual(['12345'])
  })

  test('length mode cuts at exact limit', () => {
    const result = chunk('abcdefghij', 5, 'length')
    expect(result).toEqual(['abcde', 'fghij'])
  })

  test('newline mode prefers paragraph breaks', () => {
    const _text = 'aaa\n\nbbb\n\nccc'
    // limit=9 means 'aaa\n\nbbb\n\nccc' (13 chars) needs splitting
    // paragraph break at index 3, which is > 9/2 = 4.5? No, 3 < 4.5
    // Let's use a better example
    const text2 = 'aaaa bbb\n\ncccc ddd'
    const result = chunk(text2, 12, 'newline')
    expect(result[0]).toBe('aaaa bbb')
    expect(result[1]).toBe('cccc ddd')
  })

  test('newline mode falls back to line break', () => {
    const text = 'aaaa bbbb\ncccc dddd'
    const result = chunk(text, 12, 'newline')
    expect(result[0]).toBe('aaaa bbbb')
    expect(result[1]).toBe('cccc dddd')
  })

  test('newline mode falls back to space', () => {
    const text = 'aaaa bbbb cccc dddd'
    const result = chunk(text, 12, 'newline')
    // cuts at space position, remainder keeps leading space
    expect(result[0]).toBe('aaaa bbbb')
    expect(result[1]).toBe(' cccc dddd')
  })

  test('handles empty string', () => {
    expect(chunk('', 10, 'length')).toEqual([''])
  })

  test('strips leading newlines from continuation', () => {
    // lastIndexOf('\n\n', 10) finds the paragraph break at index 7
    // first chunk includes up to that point (with trailing \n)
    // remainder has leading \n stripped
    const text = 'aaa bbb\n\n\nccc ddd'
    const result = chunk(text, 10, 'newline')
    expect(result[0]).toBe('aaa bbb\n')
    expect(result[1]).toBe('ccc ddd')
  })
})

// ---------------------------------------------------------------------------
// checkMention
// ---------------------------------------------------------------------------
describe('checkMention', () => {
  const userId = '@bot:example.com'
  const emptySet = new Set<string>()

  test('matches userId in body', () => {
    const content = { body: 'hey @bot:example.com can you help?' }
    expect(checkMention(userId, content, emptySet)).toBe(true)
  })

  test('matches userId in formatted_body', () => {
    const content = { body: 'hey', formatted_body: '<a href="...">@bot:example.com</a>' }
    expect(checkMention(userId, content, emptySet)).toBe(true)
  })

  test('matches m.mentions spec', () => {
    const content = { body: 'hey', 'm.mentions': { user_ids: ['@bot:example.com'] } }
    expect(checkMention(userId, content, emptySet)).toBe(true)
  })

  test('matches reply-to-bot via recentSentIds', () => {
    const recentIds = new Set(['$event123'])
    const content = {
      body: 'reply',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$event123' } },
    }
    expect(checkMention(userId, content, recentIds)).toBe(true)
  })

  test('matches extra regex pattern', () => {
    const content = { body: 'hey koroush, help me' }
    expect(checkMention(userId, content, emptySet, ['koroush'])).toBe(true)
  })

  test('returns false when no match', () => {
    const content = { body: 'just a normal message' }
    expect(checkMention(userId, content, emptySet)).toBe(false)
  })

  test('handles missing body gracefully', () => {
    const content = {}
    expect(checkMention(userId, content, emptySet)).toBe(false)
  })

  test('ignores invalid regex patterns', () => {
    const content = { body: 'test' }
    expect(checkMention(userId, content, emptySet, ['[invalid'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------
describe('evaluateGate', () => {
  function makeAccess(overrides?: Partial<Access>): Access {
    return { ...defaultAccess(), ...overrides }
  }

  test('disabled policy drops all', () => {
    const result = evaluateGate({
      access: makeAccess({ dmPolicy: 'disabled' }),
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('DM from allowed sender delivers', () => {
    const result = evaluateGate({
      access: makeAccess({ allowFrom: ['@user:x'] }),
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('deliver')
  })

  test('DM from unknown sender in allowlist mode drops', () => {
    const result = evaluateGate({
      access: makeAccess({ dmPolicy: 'allowlist', allowFrom: ['@other:x'] }),
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('DM from unknown sender in pairing mode returns pair', () => {
    const result = evaluateGate({
      access: makeAccess({ dmPolicy: 'pairing' }),
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(false)
    }
  })

  test('DM from sender with existing pending code returns resend', () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        abc123: { senderId: '@user:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 1 },
      },
    })
    const result = evaluateGate({
      access,
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.code).toBe('abc123')
      expect(result.isResend).toBe(true)
    }
  })

  test('DM pairing drops when sender already replied twice', () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        abc123: { senderId: '@user:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 2 },
      },
    })
    const result = evaluateGate({
      access,
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('DM pairing drops when pending is full (3)', () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        a: { senderId: '@a:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 1 },
        b: { senderId: '@b:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 1 },
        c: { senderId: '@c:x', roomId: '!r:x', createdAt: 0, expiresAt: 9999999999999, replies: 1 },
      },
    })
    const result = evaluateGate({
      access,
      senderId: '@user:x',
      isDM: true,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('room message without room policy drops', () => {
    const result = evaluateGate({
      access: makeAccess(),
      senderId: '@user:x',
      isDM: false,
      roomId: '!unknown:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('room message with requireMention=true and no mention drops', () => {
    const access = makeAccess({
      rooms: { '!r:x': { requireMention: true, allowFrom: [] } },
    })
    const result = evaluateGate({
      access,
      senderId: '@user:x',
      isDM: false,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('room message with requireMention=true and mention delivers', () => {
    const access = makeAccess({
      rooms: { '!r:x': { requireMention: true, allowFrom: [] } },
    })
    const result = evaluateGate({
      access,
      senderId: '@user:x',
      isDM: false,
      roomId: '!r:x',
      isMentioned: true,
    })
    expect(result.action).toBe('deliver')
  })

  test('room message with requireMention=false delivers without mention', () => {
    const access = makeAccess({
      rooms: { '!r:x': { requireMention: false, allowFrom: [] } },
    })
    const result = evaluateGate({
      access,
      senderId: '@user:x',
      isDM: false,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('deliver')
  })

  test('room-level allowFrom filters unauthorized sender', () => {
    const access = makeAccess({
      rooms: { '!r:x': { requireMention: false, allowFrom: ['@allowed:x'] } },
    })
    const result = evaluateGate({
      access,
      senderId: '@other:x',
      isDM: false,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('drop')
  })

  test('room-level allowFrom passes authorized sender', () => {
    const access = makeAccess({
      rooms: { '!r:x': { requireMention: false, allowFrom: ['@allowed:x'] } },
    })
    const result = evaluateGate({
      access,
      senderId: '@allowed:x',
      isDM: false,
      roomId: '!r:x',
      isMentioned: false,
    })
    expect(result.action).toBe('deliver')
  })
})
