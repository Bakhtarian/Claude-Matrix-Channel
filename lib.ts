// Pure / near-pure logic extracted from server.ts for testability.

export type PendingEntry = {
  senderId: string
  roomId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type RoomPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  version: number
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  rooms: Record<string, RoomPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  msgType?: 'm.notice' | 'm.text'
  requireVerifiedDevice?: boolean
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function defaultAccess(): Access {
  return {
    version: 1,
    dmPolicy: 'pairing',
    allowFrom: [],
    rooms: {},
    pending: {},
  }
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Check if the bot is mentioned in event content.
 * Pure version — takes userId and recentSentIds as args instead of reading from client/globals.
 */
export function checkMention(
  userId: string,
  content: Record<string, unknown>,
  recentSentIds: Set<string>,
  extraPatterns?: string[],
): boolean {
  const body = (content.body as string) ?? ''

  // Check for Matrix mention (userId in body or formatted_body)
  if (userId && body.includes(userId)) return true
  const formatted = content.formatted_body as string | undefined
  if (userId && formatted?.includes(userId)) return true

  // Check m.mentions spec (MSC3952)
  const mentions = content['m.mentions'] as { user_ids?: string[] } | undefined
  if (userId && mentions?.user_ids?.includes(userId)) return true

  // Check reply-to-bot via m.relates_to
  const relatesTo = content['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined
  const replyToId = relatesTo?.['m.in_reply_to']?.event_id
  if (replyToId && recentSentIds.has(replyToId)) return true

  // Check extra patterns
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(body)) return true
    } catch {}
  }
  return false
}

/**
 * Pure gate decision logic. Takes pre-resolved context instead of doing I/O.
 * Returns the gate action without side effects (no saving, no random code generation).
 * The caller (server.ts) handles I/O: loading access, checking DM status, saving, generating codes.
 */
export function evaluateGate(opts: {
  access: Access
  senderId: string
  isDM: boolean
  roomId: string
  isMentioned: boolean
}): GateResult {
  const { access, senderId, isDM, roomId, isMentioned } = opts

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // Pairing mode — check for existing code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending at 3
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    // Signal that a new pairing code is needed — caller generates it
    return { action: 'pair', code: '', isResend: false }
  }

  // Room message — check room policy
  const policy = access.rooms[roomId]
  if (!policy) return { action: 'drop' }
  const roomAllowFrom = policy.allowFrom ?? []
  if (roomAllowFrom.length > 0 && !roomAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  const requireMention = policy.requireMention ?? true
  if (requireMention && !isMentioned) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}
