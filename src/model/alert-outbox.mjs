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
  H12_BROAD_BEAR_REGIME: '广泛熊市过滤通过',
  H12_120_BAR_DOWNSIDE_BREAKOUT: '完成120根4小时通道向下突破',
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
  if (action === 'REVIEW_BUY' || action === 'BUY') return '做多';
  if (action === 'REVIEW_SELL' || action === 'SELL') return '做空';
  const side = String(signal?.side ?? '').toUpperCase();
  if (side === 'BUY' || side === 'LONG') return '做多';
  if (side === 'SELL' || side === 'SHORT') return '做空';
  return '观察';
}

function displayTime(value) {
  if (value == null || value === '') return '未提供';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未提供';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}（北京时间）`;
}

function displayPrice(value) {
  return value == null || value === '' ? '未提供' : String(value);
}

function displayReasons(reasons) {
  const labels = [...new Set((reasons ?? [])
    .map(reason => REASON_LABELS[String(reason)] ?? '系统条件已满足'))];
  return labels.join('；') || '系统条件已满足';
}

function displayMarketState(signal, fallback = '未提供') {
  return signal.marketState
    ?? signal.market_status
    ?? signal.marketRegime
    ?? signal.regime
    ?? fallback;
}

function displayRiskReward(signal, direction, { dynamicExit = false } = {}) {
  if (dynamicExit) return '未提供（动态退出）';
  const explicit = signal.riskRewardRatio
    ?? signal.riskReward
    ?? signal.reference?.riskRewardRatio
    ?? signal.reference?.riskReward;
  const parsedExplicit = Number(explicit);
  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) return `1:${parsedExplicit.toFixed(2)}`;

  const entry = Number(signal.reference?.entryPrice);
  const stop = Number(signal.reference?.stopPrice);
  const takeProfit = Number(signal.reference?.takeProfitPrice
    ?? signal.reference?.exitReferencePrice
    ?? signal.reference?.exitPrice);
  const risk = direction === '做多' ? entry - stop : stop - entry;
  const reward = direction === '做多' ? takeProfit - entry : entry - takeProfit;
  if (![entry, stop, takeProfit, risk, reward].every(Number.isFinite) || risk <= 0 || reward <= 0) {
    return '未提供';
  }
  return `1:${(reward / risk).toFixed(2)}`;
}

function advisoryFields(signal, { dynamicExit = false, marketFallback = '未提供' } = {}) {
  const direction = directionOf(signal);
  const takeProfit = dynamicExit
    ? '无固定止盈价（动态退出）'
    : displayPrice(signal.reference?.takeProfitPrice
      ?? signal.reference?.exitReferencePrice
      ?? signal.reference?.exitPrice);
  return [
    `交易品种：${signal.symbol ?? 'UNKNOWN'}`,
    `方向：${direction}`,
    `入场价：${displayPrice(signal.reference?.entryPrice)}`,
    `止盈价：${takeProfit}`,
    `止损价：${displayPrice(signal.reference?.stopPrice)}`,
    `失效时间：${displayTime(signal.expiresAt)}`,
    `盈亏比：${displayRiskReward(signal, direction, { dynamicExit })}`,
    `市场状态：${displayMarketState(signal, marketFallback)}`,
    `信号强度：${LEVEL_LABELS[levelOf(signal)]}`,
    `信号理由：${displayReasons(signal.reasons)}`
  ];
}

const ENTRY_EXPIRY_NOTICE = '超过失效时间未入场，则本信号作废。';
const EXIT_SEMANTICS_NOTICE = '失效时间仅限制新入场；已入场后仍按原止盈、止损或退出规则执行。';

export function formatAdvisoryEmail(signal) {
  const level = levelOf(signal);
  const symbol = signal.symbol ?? 'UNKNOWN';
  const levelLabel = LEVEL_LABELS[level];
  const dynamicExit = signal.hypothesisId === 'H12'
    || signal.reviewModel === 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL'
    || signal.reviewModel === 'DYNAMIC_CHANNEL_OR_ATR_EXIT';
  if (dynamicExit) {
    const isH12 = signal.hypothesisId === 'H12' || signal.reviewModel === 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL';
    const direction = directionOf(signal);
    const subject = isH12
      ? `[HengYu] ${symbol} H12 做空提醒（${level}）｜仅供研究`
      : `[HengYu] ${symbol} ${direction}提醒（${levelLabel}）｜仅供参考`;
    const strategyLines = isH12
      ? [
        '策略：H12 广泛熊市过滤＋120根4小时通道向下突破。',
        `初始60根通道参考：${displayPrice(signal.initialExitChannelPrice)}`,
        `动态退出规则：${signal.exitRule ?? '完成的4小时收盘价突破此前60根高点后，在下一根4小时开盘退出。'}`,
        '重要：H12没有固定止盈价，不能使用固定TP/SL模型复盘。'
      ]
      : [
        '策略：HY-EXP-0028 BULL/BUY RULE_A_CHANNEL_DISTANCE_Q75。',
        `动态退出规则：${signal.exitRule ?? 'ATR20止损或此前60根已完成1小时通道退出；系统不自动平仓。'}`
      ];
    return {
      subject,
      text: [
        subject,
        '',
        ...advisoryFields(signal, { dynamicExit: true, marketFallback: '广泛熊市' }),
        '',
        ...strategyLines,
        ENTRY_EXPIRY_NOTICE,
        EXIT_SEMANTICS_NOTICE,
        '本邮件是PAPER_ONLY研究提醒；需要人工确认，系统不会自动下单、不会读取账户。'
      ].join('\n')
    };
  }
  const direction = directionOf(signal);
  const subject = '[HengYu] ' + symbol + ' ' + direction + '提醒（' + levelLabel + '）｜仅供参考';
  const text = [
    subject,
    '',
    ...advisoryFields(signal),
    '',
    ENTRY_EXPIRY_NOTICE,
    EXIT_SEMANTICS_NOTICE,
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
