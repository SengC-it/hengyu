import { insertRow, selectRows, updateRow } from './supabase.mjs';
import nodemailer from 'nodemailer';

const DEFAULT_GMAIL_FROM_NAME = 'HengYu';

function disabled() {
  return process.env.HENGYU_GMAIL_SEND_ENABLED === 'false';
}

function gmailFromName() {
  return String(process.env.HENGYU_GMAIL_FROM_NAME || DEFAULT_GMAIL_FROM_NAME).trim()
    || DEFAULT_GMAIL_FROM_NAME;
}

export function gmailFromHeader(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const match = raw.match(/<([^<>]+)>/);
  const address = (match ? match[1] : raw).trim();
  return `${gmailFromName()} <${address}>`;
}

function smtpConfigured() {
  return !disabled() &&
    process.env.HENGYU_GMAIL_FROM_ADDRESS &&
    process.env.HENGYU_GMAIL_TO_ADDRESS &&
    process.env.HENGYU_GMAIL_APP_PASSWORD;
}

function oauthConfigured() {
  return !disabled() &&
    process.env.HENGYU_GMAIL_SEND_ENABLED === 'true' &&
    process.env.HENGYU_GMAIL_CLIENT_ID &&
    process.env.HENGYU_GMAIL_CLIENT_SECRET &&
    process.env.HENGYU_GMAIL_REFRESH_TOKEN;
}

function enabled() {
  return Boolean(smtpConfigured() || oauthConfigured());
}

export function gmailStatus() {
  return {
    configured: enabled(),
    enabled: !disabled(),
    mode: smtpConfigured() ? 'smtp_app_password' : (oauthConfigured() ? 'oauth' : null),
    fromName: gmailFromName()
  };
}

async function accessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.HENGYU_GMAIL_CLIENT_ID,
      client_secret: process.env.HENGYU_GMAIL_CLIENT_SECRET,
      refresh_token: process.env.HENGYU_GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('gmail_token_failed');
  return data.access_token;
}

function base64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sendGmailViaOAuth({ from, to, subject, text }) {
  const token = await accessToken();
  const raw = [
    `From: ${gmailFromHeader(from || process.env.HENGYU_GMAIL_FROM_ADDRESS)}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    text
  ].join('\r\n');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: base64Url(raw) })
  });
  const data = await response.json();
  if (!response.ok || !data.id) throw new Error('gmail_send_failed');
  return data.id;
}

async function sendGmailViaSmtp({ from, to, subject, text }) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.HENGYU_GMAIL_FROM_ADDRESS,
      pass: process.env.HENGYU_GMAIL_APP_PASSWORD
    }
  });
  const result = await transporter.sendMail({
    from: gmailFromHeader(from || process.env.HENGYU_GMAIL_FROM_ADDRESS),
    to: to || process.env.HENGYU_GMAIL_TO_ADDRESS,
    subject,
    text
  });
  return result.messageId || result.response || 'smtp_sent';
}

export async function sendGmail({ from, to, subject, text }) {
  if (smtpConfigured()) return sendGmailViaSmtp({ from, to, subject, text });
  if (oauthConfigured()) return sendGmailViaOAuth({ from, to, subject, text });
  throw new Error('gmail_not_enabled');
}

export async function dispatchPendingEmails(limit = 10) {
  if (!enabled()) throw new Error('gmail_not_enabled');
  const rows = await selectRows('hengyu_email_outbox', {
    select: 'outbox_id,advisory_id,alert_level,from_address,to_address,subject,body_plain,attempts',
    filters: { status: 'eq.PENDING' },
    order: 'created_at.asc',
    limit
  });
  const results = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const attempt = Number(row.attempts || 0) + 1;
    try {
      const messageId = await sendGmail({
        from: row.from_address || process.env.HENGYU_GMAIL_FROM_ADDRESS,
        to: row.to_address || process.env.HENGYU_GMAIL_TO_ADDRESS,
        subject: row.subject,
        text: row.body_plain
      });
      await updateRow('hengyu_email_outbox', { outbox_id: `eq.${row.outbox_id}` }, {
        status: 'SENT', attempts: attempt, sent_at: new Date().toISOString(), last_error: null
      });
      await insertRow('hengyu_email_deliveries', {
        outbox_id: row.outbox_id,
        attempt_number: attempt,
        status: 'SENT',
        provider_message_id: messageId,
        sent_at: new Date().toISOString()
      });
      results.push({ outboxId: row.outbox_id, status: 'SENT' });
    } catch (error) {
      await updateRow('hengyu_email_outbox', {
        outbox_id: `eq.${row.outbox_id}`
      }, { status: 'FAILED', attempts: attempt, last_error: 'gmail_delivery_failed' });
      await insertRow('hengyu_email_deliveries', {
        outbox_id: row.outbox_id,
        attempt_number: attempt,
        status: 'FAILED',
        error: 'gmail_delivery_failed'
      });
      results.push({ outboxId: row.outbox_id, status: 'FAILED' });
    }
  }
  return results;
}
