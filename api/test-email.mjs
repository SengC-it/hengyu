import { sendJson, methodAllowed, readBody, parseJson } from './_lib/http.mjs';
import { verifySignedRequest } from './_lib/signature.mjs';
import { gmailStatus, sendGmail } from './_lib/gmail.mjs';
import { formatAdvisoryEmail } from '../src/model/alert-outbox.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') return methodAllowed(response, ['POST']);
  try {
    const body = await readBody(request, 100_000);
    const signature = verifySignedRequest(request, body);
    const testSecret = process.env.HENGYU_TEST_EMAIL_SECRET || '';
    const testSecretAccepted = Boolean(testSecret) && request.headers['x-hengyu-test-secret'] === testSecret;
    if (!signature.ok && !testSecretAccepted) {
      return sendJson(response, signature.status, { error: signature.reason });
    }
    const parsed = parseJson(body);
    const simulatedMessage = parsed.signal && typeof parsed.signal === 'object'
      ? formatAdvisoryEmail(parsed.signal)
      : null;
    const report = simulatedMessage
      ? `【模拟信号，仅用于查看邮件格式，不代表真实信号】\n\n${simulatedMessage.text}`
      : parsed.report;
    if (typeof report !== 'string' || !report.trim()) {
      return sendJson(response, 400, { error: 'missing_report' });
    }
    const gmail = gmailStatus();
    if (!gmail.configured) return sendJson(response, 503, { error: 'gmail_not_configured', gmail });
    const messageId = await sendGmail({
      subject: simulatedMessage
        ? `[模拟] ${simulatedMessage.subject}`
        : (typeof parsed.subject === 'string' && parsed.subject.trim()
          ? parsed.subject.trim()
          : 'Hengyu 系统测试报告'),
      text: report
    });
    return sendJson(response, 200, { ok: true, sent: true, gmail, messageId });
  } catch (error) {
    console.error('test_email_delivery_failed', {
      code: error.code || null,
      responseCode: error.responseCode || null,
      command: error.command || null
    });
    return sendJson(response, error.status || 503, {
      error: error.message === 'gmail_not_enabled' ? 'gmail_not_configured' : 'email_test_failed'
    });
  }
}
