import { useState, useRef, useCallback, useEffect } from 'react'

const SERVER = 'http://localhost:3001'

/* ── helpers ─────────────────────────────────────────────── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isValidEmail = (s) => EMAIL_RE.test(s.trim())

const PHONE_RE = /^\d{7,15}$/
const digitsOnly = (s) => s.replace(/\D/g, '')
const isValidPhone = (s) => PHONE_RE.test(digitsOnly(s))

function formatPhone(raw) {
  const d = digitsOnly(raw)
  if (d.length === 0) return ''
  if (d.length <= 3) return `(${d}`
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  if (d.length <= 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return raw.startsWith('+') ? `+${d}` : d
}

const MAX_BODY_CHARS = 5000

/* ── API helpers ─────────────────────────────────────────── */
async function registerRule(payload) {
  const res = await fetch(`${SERVER}/api/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  return res.json()
}

async function deleteRule(id) {
  await fetch(`${SERVER}/api/rules/${id}`, { method: 'DELETE' })
}

async function fetchRules() {
  const res = await fetch(`${SERVER}/api/rules`)
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  return res.json()
}

async function checkServerHealth() {
  try {
    const res = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { ok: false }
    return res.json() // { ok, rules, imapUser }
  } catch {
    return { ok: false }
  }
}

async function pushConfig(patch) {
  try {
    await fetch(`${SERVER}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch { /* server offline — will pick up on next poll */ }
}

/* ── localStorage persistence ────────────────────────────── */
const STORAGE_KEY = 'email-composer-settings'

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function saveSettings(patch) {
  try {
    const current = loadSettings()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }))
  } catch { /* quota exceeded or private mode */ }
}

/* ── Sub-components ──────────────────────────────────────── */

function EmailTag({ address, onRemove }) {
  const valid = isValidEmail(address)
  return (
    <span className={`email-tag${valid ? '' : ' invalid'}`}>
      {address}
      <button type="button" className="email-tag-remove" onClick={onRemove} aria-label={`Remove ${address}`}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      </button>
    </span>
  )
}

function ValidationIcon({ value, touched }) {
  if (!touched || !value) return null
  const valid = isValidEmail(value)
  return (
    <span className={`validation-icon visible ${valid ? 'valid' : 'invalid'}`} aria-hidden="true">
      {valid
        ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
      }
    </span>
  )
}

function MultiEmailInput({ id, tags, onChange, placeholder }) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  const commit = useCallback((raw) => {
    const addr = raw.trim().replace(/,+$/, '')
    if (!addr) return
    onChange([...tags, addr])
    setDraft('')
  }, [tags, onChange])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  const removeTag = (idx) => onChange(tags.filter((_, i) => i !== idx))

  return (
    <div className="field-input-wrap" onClick={() => inputRef.current?.focus()}
      style={{ cursor: 'text', minHeight: '48px', paddingTop: '6px', paddingBottom: '6px' }}>
      {tags.map((t, i) => (
        <EmailTag key={`${t}-${i}`} address={t} onRemove={() => removeTag(i)} />
      ))}
      <input ref={inputRef} id={id} type="email" className="field-input"
        placeholder={tags.length === 0 ? placeholder : ''}
        value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown} onBlur={() => commit(draft)}
        autoComplete="email" aria-label={placeholder}
        style={{ paddingTop: '6px', paddingBottom: '6px' }}
      />
    </div>
  )
}

function SingleEmailInput({ id, value, onChange, placeholder, onBlur, touched }) {
  return (
    <div className="field-input-wrap" style={{ minHeight: '48px' }}>
      <input id={id} type="email" className="field-input" placeholder={placeholder}
        value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
        autoComplete="email" aria-label={placeholder}
        aria-invalid={touched && value ? !isValidEmail(value) : undefined}
      />
      <ValidationIcon value={value} touched={touched} />
    </div>
  )
}

/**
 * App Password input with show/hide toggle.
 */
function AppPasswordInput({ id, value, onChange, onBlur, touched }) {
  const [visible, setVisible] = useState(false)
  const hasValue = value.length > 0
  const looks16 = digitsOnly(value.replace(/\s/g, '')).length === 0 && value.replace(/\s/g, '').length === 16
  // App passwords are 16 lowercase letters (no digits)
  const isAppPass = /^[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}$/.test(value.trim())
  const iconCls = `validation-icon${touched && hasValue ? ' visible' : ''}${touched && hasValue ? (isAppPass ? ' valid' : ' invalid') : ''}`

  return (
    <div className="field-input-wrap" style={{ minHeight: '48px' }}>
      {/* Key icon */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ color: 'var(--color-text-placeholder)', flexShrink: 0, marginRight: '-2px' }} aria-hidden="true">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
      </svg>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        className="field-input"
        placeholder="xxxx xxxx xxxx xxxx"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        autoComplete="off"
        spellCheck={false}
        aria-label="Gmail App Password"
        aria-invalid={touched && hasValue ? !isAppPass : undefined}
        maxLength={19}
      />
      {/* Show/hide toggle */}
      <button
        type="button"
        className="password-toggle-btn"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide' : 'Show'}
      >
        {visible
          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        }
      </button>
      <span className={iconCls} aria-hidden="true">
        {touched && hasValue && (
          isAppPass
            ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        )}
      </span>
    </div>
  )
}

function PhoneInput({ id, value, onChange, onBlur, touched }) {
  const handleChange = (e) => {
    const raw = e.target.value
    if (raw.length < value.length) {
      onChange(formatPhone(digitsOnly(raw)))
    } else {
      onChange(formatPhone(raw))
    }
  }
  const valid = value ? isValidPhone(value) : null
  const iconCls = `validation-icon${touched && value ? ' visible' : ''}${touched && value ? (valid ? ' valid' : ' invalid') : ''}`

  return (
    <div className="field-input-wrap" style={{ minHeight: '48px' }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ color: 'var(--color-text-placeholder)', flexShrink: 0, marginRight: '-2px' }} aria-hidden="true">
        <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.49 12 19.79 19.79 0 01.47 3.38 2 2 0 012.46 1.21h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 8.64a16 16 0 006.29 6.29l1.5-1.5a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
      </svg>
      <input id={id} type="tel" className="field-input" placeholder="(555) 867-5309"
        value={value} onChange={handleChange} onBlur={onBlur}
        autoComplete="tel" inputMode="tel" aria-label="Text / phone number"
        aria-invalid={touched && value ? !valid : undefined} maxLength={18}
      />
      <span className={iconCls} aria-hidden="true">
        {touched && value && (valid
          ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        )}
      </span>
    </div>
  )
}

/* ── Server status badge ─────────────────────────────────── */
function ServerBadge({ online }) {
  return (
    <div className={`server-badge ${online ? 'online' : 'offline'}`} title={online ? 'Backend connected' : 'Backend offline — start server/index.js'}>
      <span className="server-badge-dot" />
      {online ? 'Server online' : 'Server offline'}
    </div>
  )
}

/* ── Active rules panel ──────────────────────────────────── */
function ActiveRules({ rules, onDelete }) {
  if (rules.length === 0) return null
  return (
    <div className="rules-panel">
      <div className="rules-panel-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>
        </svg>
        <span>Watching inbox{rules.length > 1 ? ` (${rules.length} rules)` : ''}</span>
        <span className="rules-pulse" aria-hidden="true" />
      </div>
      <ul className="rules-list" aria-label="Active forwarding rules">
        {rules.map(r => (
          <li key={r.id} className="rule-item">
            <div className="rule-detail">
              <span className="rule-addr">{r.from}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              <span className="rule-addr">{r.to}</span>
              <span className="rule-sep">→ SMS</span>
              <span className="rule-phone">{r.phone}</span>
            </div>
            <button
              type="button"
              className="rule-delete-btn"
              onClick={() => onDelete(r.id)}
              aria-label={`Stop watching rule: ${r.from} → ${r.to}`}
              title="Stop watching"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── Clock ───────────────────────────────────────────────── */
function LiveClock() {
  const [time, setTime] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return <span className="toolbar-time">{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
}

/* ── Toast ───────────────────────────────────────────────── */
function Toast({ message, show, icon }) {
  return (
    <div className={`toast${show ? ' show' : ''}`} role="status" aria-live="polite">
      <span className="toast-icon">{icon}</span>
      {message}
    </div>
  )
}

/* ── Main App ────────────────────────────────────────────── */
export default function App() {
  // Seed from persisted settings
  const saved = loadSettings()

  const [from, setFrom] = useState(saved.from ?? '')
  const [fromTouched, setFromTouched] = useState(!!saved.from)
  const [phone, setPhone] = useState(saved.phone ?? '')
  const [phoneTouched, setPhoneTouched] = useState(!!saved.phone)
  const [appPass, setAppPass] = useState(saved.appPass ?? '')
  const [appPassTouched, setAppPassTouched] = useState(!!saved.appPass)
  const [toTags, setToTags] = useState(saved.toTags ?? [])
  const [ccTags, setCcTags] = useState([])
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState(saved.subject ?? '')
  const [body, setBody] = useState(saved.body ?? '')
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState({ show: false, message: '', icon: '' })
  const [savedIndicator, setSavedIndicator] = useState(false)
  const saveTimer = useRef(null)

  // Backend state
  const [serverOnline, setServerOnline] = useState(false)
  const [activeRules, setActiveRules] = useState([])
  const [imapUser, setImapUser] = useState('')

  const bodyLen = body.length
  const charCls = bodyLen > MAX_BODY_CHARS ? 'over' : bodyLen > MAX_BODY_CHARS * 0.85 ? 'warning' : ''

  // Persist all fields whenever they change (debounced 600ms)
  useEffect(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveSettings({ from, phone, appPass, toTags, subject, body })
      setSavedIndicator(true)
      setTimeout(() => setSavedIndicator(false), 1800)
    }, 600)
    return () => clearTimeout(saveTimer.current)
  }, [from, phone, appPass, toTags, subject, body])

  // Push app password to server whenever it changes (debounced 1s)
  const configTimer = useRef(null)
  useEffect(() => {
    if (!appPass) return
    clearTimeout(configTimer.current)
    configTimer.current = setTimeout(() => pushConfig({ imapPass: appPass }), 1000)
    return () => clearTimeout(configTimer.current)
  }, [appPass])

  // Poll server health + rules every 10s
  useEffect(() => {
    let cancelled = false
    const hasSeededTo = { current: toTags.length > 0 } // don't overwrite if user already has tags
    const poll = async () => {
      const data = await checkServerHealth()
      if (cancelled) return
      setServerOnline(!!data.ok)
      if (data.ok) {
        // Seed To field with IMAP inbox address only once, on first connect
        if (data.imapUser && !hasSeededTo.current) {
          hasSeededTo.current = true
          setImapUser(data.imapUser)
          setToTags(prev => prev.length === 0 ? [data.imapUser] : prev)
        } else if (data.imapUser) {
          setImapUser(data.imapUser)
        }
        try {
          const rules = await fetchRules()
          if (!cancelled) setActiveRules(rules)
        } catch { /* ignore */ }
      }
    }
    poll()
    const id = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const showToast = (message, icon = '✉️') => {
    setToast({ show: true, message, icon })
    setTimeout(() => setToast(t => ({ ...t, show: false })), 4000)
  }

  const allToValid = toTags.length > 0 && toTags.every(isValidEmail)
  const fromValid = from && isValidEmail(from)
  const phoneValid = phone && isValidPhone(phone)
  const canSend = allToValid && fromValid && subject.trim() && bodyLen > 0 && bodyLen <= MAX_BODY_CHARS

  const resetForm = (clearSettings = false) => {
    if (clearSettings) {
      saveSettings({ from: '', phone: '', appPass: '', toTags: [], subject: '', body: '' })
      setFrom(''); setFromTouched(false)
      setPhone(''); setPhoneTouched(false)
      setAppPass(''); setAppPassTouched(false)
      setToTags([]); setSubject(''); setBody('')
    }
    setCcTags([]); setShowCc(false)
  }

  const handleSend = async (e) => {
    e.preventDefault()
    if (!canSend || sending) return
    setSending(true)

    try {
      // Register forwarding rule with backend if server is online and phone provided
      if (serverOnline && phoneValid) {
        for (const toAddr of toTags) {
          try {
            const rule = await registerRule({ from, to: toAddr, phone, label: subject })
            setActiveRules(prev => [...prev, rule])
          } catch (err) {
            console.warn('[rule] Failed to register:', err.message)
          }
        }
        showToast('Rule active — watching inbox for replies → SMS', '📱')
      } else if (phoneValid && !serverOnline) {
        showToast('Server offline — start server/index.js to enable SMS', '⚠️')
      } else {
        showToast('Email configured! (Add a phone number to enable SMS)', '✉️')
      }

      // Simulate email send delay
      await new Promise(r => setTimeout(r, 800))
    } finally {
      setSending(false)
    }

    // Settings (including subject/body) persist — only clear CC and close CC panel
    resetForm(false)
  }

  const handleDeleteRule = async (id) => {
    try {
      await deleteRule(id)
      setActiveRules(prev => prev.filter(r => r.id !== id))
      showToast('Forwarding rule removed', '🗑️')
    } catch {
      showToast('Failed to remove rule', '❌')
    }
  }

  const handleDiscard = () => {
    resetForm(false)
    showToast('Draft discarded', '🗑️')
  }

  const handleClearSettings = () => {
    resetForm(true)
    showToast('Saved settings cleared', '🗑️')
  }

  return (
    <>
      <div className="app-bg" aria-hidden="true" />

      <main className="app-layout">
        <div className="composer-wrapper">
          {/* Header */}
          <header className="composer-header">
            <div className="composer-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="3"/>
                <path d="M2 8l10 7 10-7"/>
              </svg>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
              <h1 className="composer-title">Compose Email</h1>
              <ServerBadge online={serverOnline} />
            </div>
            <p className="composer-subtitle">
              {serverOnline
                ? 'Fill in a phone number — replies will text you automatically'
                : 'Craft beautiful messages with ease'}
            </p>
            {savedIndicator && (
              <div className="settings-saved-badge" aria-live="polite">
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 7l4 4 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Settings saved
              </div>
            )}
          </header>

          {/* Active rules panel */}
          <ActiveRules rules={activeRules} onDelete={handleDeleteRule} />

          {/* Main card */}
          <form className="composer-card" onSubmit={handleSend} noValidate aria-label="Email composer">
            {/* Toolbar */}
            <div className="composer-toolbar" aria-hidden="true">
              <div className="toolbar-dots">
                <div className="toolbar-dot" /><div className="toolbar-dot" /><div className="toolbar-dot" />
              </div>
              <span className="toolbar-label">New Message</span>
              <LiveClock />
            </div>

            {/* Fields */}
            <div className="composer-fields">
              {/* FROM */}
              <div className="field-row">
                <label className="field-label" htmlFor="from-input">From</label>
                <SingleEmailInput id="from-input" value={from} onChange={setFrom}
                  placeholder="your@email.com" onBlur={() => setFromTouched(true)} touched={fromTouched} />
              </div>
              {fromTouched && from && !isValidEmail(from) && (
                <p className="field-error-hint" role="alert">Please enter a valid email address.</p>
              )}

              {/* PHONE */}
              <div className="field-row">
                <label className="field-label" htmlFor="phone-input">Phone</label>
                <PhoneInput id="phone-input" value={phone} onChange={setPhone}
                  onBlur={() => setPhoneTouched(true)} touched={phoneTouched} />
              </div>
              {phoneTouched && phone && !isValidPhone(phone) && (
                <p className="field-error-hint" role="alert">Please enter a valid phone number (7–15 digits).</p>
              )}

              {/* APP PASSWORD */}
              <div className="field-row">
                <label className="field-label" htmlFor="apppass-input">App Pass</label>
                <AppPasswordInput
                  id="apppass-input"
                  value={appPass}
                  onChange={setAppPass}
                  onBlur={() => setAppPassTouched(true)}
                  touched={appPassTouched}
                />
              </div>
              {appPassTouched && appPass && !/^[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}\s?[a-z]{4}$/.test(appPass.trim()) && (
                <p className="field-error-hint" role="alert">Should be 16 lowercase letters (e.g. abcd efgh ijkl mnop).</p>
              )}

              {/* TO */}
              <div className="field-row">
                <label className="field-label" htmlFor="to-input">To</label>
                <MultiEmailInput id="to-input" tags={toTags} onChange={setToTags}
                  placeholder="Recipient(s) — press Enter to add" />
              </div>

              {/* CC */}
              {showCc && (
                <div className="field-row">
                  <label className="field-label" htmlFor="cc-input">Cc</label>
                  <MultiEmailInput id="cc-input" tags={ccTags} onChange={setCcTags}
                    placeholder="CC recipients — press Enter to add" />
                </div>
              )}

              {/* Subject */}
              <div className="field-row subject-row" style={{ display: 'block' }}>
                <label className="field-label" htmlFor="subject-input" style={{ display: 'none' }}>Subject</label>
                <input id="subject-input" type="text" className="subject-input" placeholder="Subject"
                  value={subject} onChange={(e) => setSubject(e.target.value)}
                  maxLength={998} autoComplete="off" aria-label="Email subject" />
              </div>

              {/* Body */}
              <div className="message-body-wrap">
                <label htmlFor="body-input" style={{ display: 'none' }}>Message body</label>
                <textarea id="body-input" className="message-body" placeholder="Write your message here…"
                  value={body} onChange={(e) => setBody(e.target.value)}
                  aria-label="Message body" aria-describedby="char-count" />
              </div>
              <div id="char-count" className={`char-count${charCls ? ` ${charCls}` : ''}`}>
                {bodyLen.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()}
              </div>
            </div>

            {/* Actions */}
            <div className="composer-actions">
              <div className="actions-left">
                <button type="button" className="icon-btn" aria-label="Attach file" title="Attach file">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                <button type="button" className="icon-btn" onClick={() => setShowCc(v => !v)}
                  aria-pressed={showCc} aria-label={showCc ? 'Hide CC field' : 'Add CC recipients'} title="Cc"
                  style={showCc ? { borderColor: 'rgba(139,92,246,0.5)', color: '#c4b5fd', background: 'rgba(139,92,246,0.1)' } : {}}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em' }}>CC</span>
                </button>
                <button type="button" className="icon-btn" onClick={handleDiscard} aria-label="Discard draft" title="Discard draft">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
                  </svg>
                </button>

                {/* Clear saved settings */}
                <button type="button" className="icon-btn" onClick={handleClearSettings}
                  aria-label="Clear saved settings" title="Clear saved From, Phone & To">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="15" y1="9" x2="9" y2="15"/>
                    <line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                </button>
              </div>

              <button type="submit" id="send-btn"
                className={`send-btn${sending ? ' sending' : ''}`}
                disabled={!canSend || sending} aria-label="Send email">
                {sending
                  ? <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>Sending…</>
                  : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send</>
                }
              </button>
            </div>
          </form>
        </div>
      </main>

      <Toast show={toast.show} message={toast.message} icon={toast.icon} />

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  )
}
