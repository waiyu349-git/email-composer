import twilio from 'twilio'

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const MAX_SMS_CHARS = 1600

/**
 * Send an SMS notifying the recipient that a matching email arrived.
 *
 * @param {object} opts
 * @param {string} opts.to        - Destination phone number (E.164, e.g. +15551234567)
 * @param {string} opts.fromEmail - The sender email address
 * @param {string} opts.toEmail   - The recipient email address
 * @param {string} opts.subject   - Email subject
 * @param {string} opts.body      - Plain-text email body
 */
export async function sendSms({ to, fromEmail, toEmail, subject, body }) {
  const preview = body?.trim().slice(0, 400) ?? ''
  const ellipsis = (body?.trim().length ?? 0) > 400 ? '…' : ''

  const message = [
    `📧 New email on ${toEmail}`,
    `From: ${fromEmail}`,
    `Subject: ${subject || '(no subject)'}`,
    '',
    preview + ellipsis,
  ]
    .join('\n')
    .slice(0, MAX_SMS_CHARS)

  const result = await client.messages.create({
    body: message,
    from: process.env.TWILIO_FROM_NUMBER,
    to,
  })

  console.log(`[sms] Sent to ${to} — SID: ${result.sid}`)
  return result.sid
}
