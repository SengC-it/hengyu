export const PAPER_ONLY = {
  mode: 'SIGNAL_ONLY',
  authorization: 'PAPER_ONLY',
  liveOrdersEnabled: false,
  orderPlacementEnabled: false,
  accountAccess: false,
  humanConfirmationRequired: true
};

const FORBIDDEN_KEY = /(balance|leverage|quantity|qty|position|notional|order|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|secret)/i;
const PAPER_ONLY_KEYS = new Set([
  'authorization_mode',
  'live_orders_enabled',
  'order_placement_enabled',
  'order_placement',
  'account_access',
  'human_confirmation_required',
  'mode',
  'authorization'
]);

export function assertPaperOnly(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid_record');
  if (record.authorization_mode && record.authorization_mode !== 'PAPER_ONLY') {
    throw new Error('paper_only_required');
  }
  if (record.authorization && record.authorization !== 'PAPER_ONLY') {
    throw new Error('paper_only_required');
  }
  if (record.live_orders_enabled === true
    || record.order_placement_enabled === true
    || record.order_placement === true
    || record.account_access === true) {
    throw new Error('live_orders_disabled');
  }
  for (const key of Object.keys(record)) {
    if (PAPER_ONLY_KEYS.has(key)) continue;
    if (FORBIDDEN_KEY.test(key)) throw new Error(`forbidden_field:${key}`);
  }
  return true;
}

export function safetyEnvelope(extra = {}) {
  return { ...PAPER_ONLY, ...extra };
}
