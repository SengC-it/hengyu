import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';

import {
  dispatchPendingEmails,
  gmailStatus,
  sendGmail
} from '../api/_lib/gmail.mjs';

const ENV_NAMES = [
  'HENGYU_GMAIL_SEND_ENABLED',
  'HENGYU_GMAIL_FROM_ADDRESS',
  'HENGYU_GMAIL_TO_ADDRESS',
  'HENGYU_GMAIL_APP_PASSWORD',
  'HENGYU_GMAIL_CLIENT_ID',
  'HENGYU_GMAIL_CLIENT_SECRET',
  'HENGYU_GMAIL_REFRESH_TOKEN'
];

function snapshotEnvironment() {
  return Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
}

function restoreEnvironment(previous) {
  for (const name of ENV_NAMES) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

function setSmtpCredentials() {
  process.env.HENGYU_GMAIL_FROM_ADDRESS = 'research@example.com';
  process.env.HENGYU_GMAIL_TO_ADDRESS = 'owner@example.com';
  process.env.HENGYU_GMAIL_APP_PASSWORD = 'test-app-password';
  delete process.env.HENGYU_GMAIL_CLIENT_ID;
  delete process.env.HENGYU_GMAIL_CLIENT_SECRET;
  delete process.env.HENGYU_GMAIL_REFRESH_TOKEN;
}

function setOauthCredentials() {
  delete process.env.HENGYU_GMAIL_FROM_ADDRESS;
  delete process.env.HENGYU_GMAIL_TO_ADDRESS;
  delete process.env.HENGYU_GMAIL_APP_PASSWORD;
  process.env.HENGYU_GMAIL_CLIENT_ID = 'test-client-id';
  process.env.HENGYU_GMAIL_CLIENT_SECRET = 'test-client-secret';
  process.env.HENGYU_GMAIL_REFRESH_TOKEN = 'test-refresh-token';
}

test('Gmail enable gate accepts only the exact true literal', () => {
  const previous = snapshotEnvironment();
  const cases = [
    ['undefined/missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['False', 'False'],
    ['FALSE', 'FALSE'],
    ['null string', 'null'],
    ['0', '0'],
    ['1', '1'],
    ['yes', 'yes'],
    ['TRUE', 'TRUE'],
    ['space padded true', ' true '],
    ['exact true', 'true']
  ];

  try {
    for (const [label, value] of cases) {
      setSmtpCredentials();
      if (value === undefined) delete process.env.HENGYU_GMAIL_SEND_ENABLED;
      else process.env.HENGYU_GMAIL_SEND_ENABLED = value;

      const status = gmailStatus();
      const expected = value === 'true';
      assert.equal(status.enabled, expected, label);
      assert.equal(status.configured, expected, label);
      assert.equal(status.mode, expected ? 'smtp_app_password' : null, label);
    }
  } finally {
    restoreEnvironment(previous);
  }
});

test('exact true enables OAuth only when OAuth credentials are complete', () => {
  const previous = snapshotEnvironment();
  try {
    process.env.HENGYU_GMAIL_SEND_ENABLED = 'true';
    setOauthCredentials();
    assert.deepEqual(gmailStatus(), {
      configured: true,
      enabled: true,
      mode: 'oauth',
      fromName: 'HengYu'
    });
  } finally {
    restoreEnvironment(previous);
  }
});

test('disabled gate blocks SMTP before nodemailer transport creation', async () => {
  const previous = snapshotEnvironment();
  let createTransportCalls = 0;
  const originalCreateTransport = nodemailer.createTransport;
  try {
    setSmtpCredentials();
    process.env.HENGYU_GMAIL_SEND_ENABLED = 'TRUE';
    nodemailer.createTransport = () => {
      createTransportCalls += 1;
      throw new Error('unexpected_smtp_transport');
    };

    await assert.rejects(
      sendGmail({ subject: 'test', text: 'test' }),
      error => error?.message === 'gmail_not_enabled'
    );
    assert.equal(createTransportCalls, 0);
  } finally {
    nodemailer.createTransport = originalCreateTransport;
    restoreEnvironment(previous);
  }
});

test('disabled gate blocks OAuth before token or Gmail API requests', async () => {
  const previous = snapshotEnvironment();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  try {
    setOauthCredentials();
    process.env.HENGYU_GMAIL_SEND_ENABLED = '1';
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('unexpected_gmail_request');
    };

    await assert.rejects(
      sendGmail({ subject: 'test', text: 'test' }),
      error => error?.message === 'gmail_not_enabled'
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test('dispatchPendingEmails rejects before reading pending rows when gate is disabled', async () => {
  const previous = snapshotEnvironment();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  try {
    setSmtpCredentials();
    process.env.HENGYU_GMAIL_SEND_ENABLED = 'false';
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('unexpected_supabase_or_gmail_request');
    };

    await assert.rejects(
      dispatchPendingEmails(),
      error => error?.message === 'gmail_not_enabled'
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});
