import { ImapFlow } from 'imapflow'
import { sendSms } from './sms.js'
import { runtimeConfig } from './config.js'

// In-memory rule store (injected from index.js)
let rulesRef = null
export function setRules(ref) { rulesRef = ref }

const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10)

// Track message UIDs we've already processed so we never double-text
const seenUids = new Set()

/**
 * Create and return a connected ImapFlow client for Gmail.
 */
function createClient() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT ?? '993', 10),
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: runtimeConfig.imapPass, // live-updated from UI
    },
    logger: false,
  })
  // Prevent uncaught 'error' events from crashing Node
  client.on('error', (err) => {
    console.error('[watcher] IMAP connection error:', err.code ?? err.message)
  })
  return client
}

/**
 * Parse a plain-text body from a parsed message.
 * imapflow's `bodyPart` gives us the raw text; we just trim it.
 */
function extractText(message) {
  if (!message?.bodyStructure) return ''
  // Try to find a text/plain part
  const findPlain = (part) => {
    if (!part) return null
    if (part.type === 'text' && part.subtype === 'plain') return part.part ?? '1'
    if (part.childNodes) {
      for (const child of part.childNodes) {
        const found = findPlain(child)
        if (found) return found
      }
    }
    return null
  }
  return findPlain(message.bodyStructure) ?? '1'
}

/**
 * Poll the inbox once: fetch unseen messages and check against all rules.
 */
async function pollOnce() {
  if (!rulesRef || rulesRef.size === 0) return // nothing to watch

  // Only fetch messages received on or after the earliest rule creation date
  const dates = [...rulesRef.values()].map(r => new Date(r.createdAt))
  const since = new Date(Math.min(...dates))
  since.setHours(0, 0, 0, 0) // round to start of that day

  let client
  try {
    client = createClient()
    await client.connect()
    await client.mailboxOpen('INBOX')

    // Search for messages since the earliest rule date (returns UIDs)
    const uids = await client.search({ since })
    if (!uids || uids.length === 0) {
      await client.logout()
      return
    }

    const uidRange = uids.join(',')
    const messages = []
    for await (const msg of client.fetch(uidRange, {
      envelope: true,
      bodyStructure: true,
      uid: true,
    })) {
      messages.push(msg)
    }

    console.log(`[watcher] Poll: ${messages.length} message(s) found since ${since.toDateString()}`)
    for (const msg of messages) {
      const uid = String(msg.uid)
      if (seenUids.has(uid)) continue

      const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? ''
      const toAddr   = msg.envelope?.to?.[0]?.address?.toLowerCase() ?? ''
      const subject  = msg.envelope?.subject ?? ''

      // Check every rule
      for (const rule of rulesRef.values()) {
        const ruleFrom = rule.from.toLowerCase()
        const ruleTo   = rule.to.toLowerCase()

        if (fromAddr !== ruleFrom || toAddr !== ruleTo) continue

        console.log(`[watcher] Match! UID=${uid}  from=${fromAddr} → to=${toAddr}`)

        // Fetch the body of the matched message
        let bodyText = ''
        try {
          const partId = extractText(msg)
          const { content } = await client.download(uid, partId, { uid: true })
          const chunks = []
          for await (const chunk of content) chunks.push(chunk)
          bodyText = Buffer.concat(chunks).toString('utf8')
        } catch (e) {
          console.warn('[watcher] Could not fetch body:', e.message)
        }

        try {
          await sendSms({
            to:        rule.phone,
            fromEmail: fromAddr,
            toEmail:   toAddr,
            subject,
            body:      bodyText,
          })
        } catch (e) {
          console.error('[watcher] SMS send failed:', e.message)
        }

        seenUids.add(uid)
        // One rule matched — no need to check others for this message
        break
      }

      // Mark as processed even if no rule matched, to skip next poll
      seenUids.add(uid)
    }

    await client.logout()
  } catch (err) {
    const detail = err.authenticationFailed ? 'Auth failed — check App Password' : (err.code ?? err.message)
    console.error('[watcher] IMAP error:', detail)
    try { client?.close() } catch (_) { /* ignore */ }
  }
}

let pollTimer = null

/** Start the polling loop. */
export function startWatcher() {
  if (pollTimer) return
  console.log(`[watcher] Starting — polling every ${POLL_MS / 1000}s`)

  // Run immediately, then on interval
  pollOnce()
  pollTimer = setInterval(pollOnce, POLL_MS)
}

/** Stop the polling loop. */
export function stopWatcher() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log('[watcher] Stopped')
  }
}
