import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { randomUUID } from 'crypto'
import { setRules, startWatcher } from './watcher.js'
import { runtimeConfig } from './config.js'

// ── Validate required env vars ─────────────────────────────────────────────────────
const REQUIRED = [
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
]
const missing = REQUIRED.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error('❌  Missing required env vars:', missing.join(', '))
  console.error('   Copy server/.env.example → server/.env and fill in the values.')
  process.exit(1)
}

// ── In-memory rule store ─────────────────────────────────────────────────────
/** @type {Map<string, {id, from, to, phone, label, createdAt}>} */
const rules = new Map()
setRules(rules)

// ── Express setup ────────────────────────────────────────────────────────────
const app = express()
app.use(cors({
  origin: (origin, cb) => {
    // Allow any localhost origin (any port) or no origin (curl/Postman)
    if (!origin || /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true)
    cb(new Error(`CORS: ${origin} not allowed`))
  }
}))
app.use(express.json())

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rules: rules.size, imapUser: process.env.IMAP_USER })
})

// Update runtime config (e.g. IMAP app password from the UI)
app.post('/api/config', (req, res) => {
  const { imapPass } = req.body ?? {}
  if (imapPass !== undefined) {
    runtimeConfig.imapPass = imapPass.trim()
    console.log('[api] IMAP password updated via UI')
  }
  res.json({ ok: true })
})

// List all active rules
app.get('/api/rules', (_req, res) => {
  res.json([...rules.values()])
})

// Create a new forwarding rule
app.post('/api/rules', (req, res) => {
  const { from, to, phone, label } = req.body ?? {}

  if (!from || !to || !phone) {
    return res.status(400).json({ error: 'from, to, and phone are required' })
  }

  // Normalise
  const rule = {
    id:        randomUUID(),
    from:      from.trim().toLowerCase(),
    to:        to.trim().toLowerCase(),
    phone:     phone.trim(),
    label:     label?.trim() ?? '',
    createdAt: new Date().toISOString(),
  }

  rules.set(rule.id, rule)
  console.log(`[api] Rule created: ${rule.from} → ${rule.to} → SMS ${rule.phone}  (id=${rule.id})`)

  res.status(201).json(rule)
})

// Delete a rule
app.delete('/api/rules/:id', (req, res) => {
  const { id } = req.params
  if (!rules.has(id)) return res.status(404).json({ error: 'Rule not found' })
  rules.delete(id)
  console.log(`[api] Rule deleted: ${id}`)
  res.json({ deleted: id })
})

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen(PORT, () => {
  console.log(`\n✅  Server listening on http://localhost:${PORT}`)
  console.log(`📬  Watching inbox: ${process.env.IMAP_USER}`)
  console.log(`📱  SMS from: ${process.env.TWILIO_FROM_NUMBER}\n`)
  startWatcher()
})

// Graceful shutdown
process.on('SIGINT',  () => { console.log('\nShutting down…'); process.exit(0) })
process.on('SIGTERM', () => { console.log('\nShutting down…'); process.exit(0) })
