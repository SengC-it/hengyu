import fs from 'node:fs';
import path from 'node:path';

const EMAIL_LEVELS = new Set(['STRONG', 'MEDIUM']);

const LEVEL_LABELS = Object.freeze({
  STRONG: '较强',
  MEDIUM: '一般',
  OBSERVE: '观察',
  NONE: '普通'
});

const REASON_LABELS = Object.freeze({
  H9_FORCE_PRESSURE_RECOVERY: '价格下跌后出现反弹迹象',
  PRESSURE_THRESHOLD_BREACH: '市场波动达到提醒标准',
  DEPTH_RECOVERY: '当前买卖力量正在恢复',
  future_timestamp: '数据时间异常',
  stale_forecast: '预测数据已经过时',
  stale_book: '市场价格数据已经过时',
  insufficient_visible_depth: '当前可成交数量不足',
  visible_depth_participation: '当前可成交数量有限',
  non_positive_price_edge: '预期价格空间不足',
  insufficient_cost_coverage: '预期空间不足以覆盖费用',
  insufficient_conservative_net_edge: '扣除费用和风险后，剩余空间不足',
  pressure_below_threshold: '市场波动还没有达到提醒标准',
  insufficient_recovery: '反弹力度不足',
  missing_event_impulse: '缺少足够的价格变化'
});

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function levelOf(signal) {
  const level = String(signal?.alertLevel ?? 'NONE').toUpperCase();
  if (!['STRONG', 'MEDIUM', 'OBSERVE', 'NONE'].includes(level)) throw new Error('invalid alert level');
  return level;
}

function directionOf(signal) {
  const action = String(signal?.action ?? '').toUpperCase();
  if (action === 'REVIEW_BUY' || action === 'BUY') return '买入';
  if (action === 'REVIEW_SELL' || action === 'SELL') return '卖出';
  const side = String(signal?.side ?? '').toUpperCase();
  if (side === 'BUY' || side === 'LONG') return '买入';
  if (side === 'SELL' || side === 'SHORT') return '卖出';
  return '观察';
}

function displayTime(value) {
  if (value == null || value === '') return '未提供';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未提供';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  }) + '（北京时间）';
}

function displayPrice(value) {
  return value == null || value === '' ? '未提供' : String(value);
}

function displayNetSpace(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (parsed / 100).toFixed(2) + '%' : '未提供';
}

function displayReasons(reasons) {
  const labels = [...new Set((reasons ?? [])
    .map(reason => REASON_LABELS[String(reason)] ?? '系统条件已满足'))];
  return labels.join('；') || '系统条件已满足';
}

export function formatAdvisoryEmail(signal) {
  const level = levelOf(signal);
  const symbol = signal.symbol ?? 'UNKNOWN';
  const entry = signal.reference?.entryPrice;
  const stop = signal.reference?.stopPrice;
  const takeProfit = signal.reference?.takeProfitPrice
    ?? signal.reference?.exitReferencePrice
    ?? signal.reference?.exitPrice;
  const direction = directionOf(signal);
  const levelLabel = LEVEL_LABELS[level];
  const subject = '[HengYu] ' + symbol + ' ' + direction + '提醒（' + levelLabel + '）｜仅供参考';
  const text = [
    subject,
    '',
    '信号方向：' + direction,
    '信号强度：' + levelLabel,
    '交易品种：' + symbol,
    '',
    '价格参考（复盘只使用下面三项）：',
    '入场价：' + displayPrice(entry),
    '止损价：' + displayPrice(stop),
    '止盈价：' + displayPrice(takeProfit),
    '',
    '信号有效到：' + displayTime(signal.expiresAt),
    '结算规则：入场后，止损价和止盈价谁先触及就按谁结算；如果两者都没有触及，就继续持仓，不会因为时间到了自动平仓。',
    '预计扣除费用后的空间：' + displayNetSpace(signal.costs?.conservativeNetEdgeBps) + '（仅作参考，不代表保证盈利）',
    '触发原因：' + displayReasons(signal.reasons),
    '',
    '重要提醒：这是一封研究提醒，不是买卖指令。系统不会自动下单，也不会读取或动用你的账户资金。'
  ].join('\n');
  return { subject, text };
}

export function buildAlertDelivery(signal, { now = Date.now() } = {}) {
  if (!signal?.signalId) throw new Error('signalId is required');
  const level = levelOf(signal);
  const createdAt = integer('createdAt', now);
  const email = EMAIL_LEVELS.has(level)
    ? (level === 'STRONG' ? 'IMMEDIATE' : 'DIGEST_15M')
    : 'NONE';
  return {
    schemaVersion: 1,
    recordType: 'ADVISORY_ALERT_OUTBOX',
    outboxId: `${signal.signalId}:${level}`,
    dedupeKey: signal.delivery?.dedupeKey ?? `${signal.signalId}:${level}`,
    createdAt,
    signalId: signal.signalId,
    experimentId: signal.experimentId,
    symbol: signal.symbol,
    side: signal.side,
    alertLevel: level,
    web: true,
    email,
    message: formatAdvisoryEmail(signal),
    status: 'PENDING',
    manualOnly: true,
    orderPlacement: false,
    accountAccess: false
  };
}

export function appendAlertOutbox(file, entry) {
  if (!file || typeof file !== 'string') throw new Error('outbox file is required');
  if (!entry || entry.recordType !== 'ADVISORY_ALERT_OUTBOX') throw new Error('invalid outbox entry');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  let existing = [];
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text) existing = text.split(/\r?\n/).map(line => JSON.parse(line));
  }
  if (existing.some(row => row.dedupeKey === entry.dedupeKey)) {
    return { appended: false, duplicate: true, entry };
  }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return { appended: true, duplicate: false, entry };
}

export function readAlertOutbox(file, { limit = 100 } = {}) {
  const count = integer('limit', limit, { minimum: 1 });
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(-count).reverse();
}
