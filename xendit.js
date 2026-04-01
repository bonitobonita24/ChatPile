// Xendit Recurring Payments API helper
// Docs: https://developers.xendit.co/api-reference

const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY || '';
const XENDIT_CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN || '';
const XENDIT_BASE = 'https://api.xendit.co';
const PLAN_CURRENCY = process.env.XENDIT_PLAN_CURRENCY || 'PHP';

function authHeader() {
  return 'Basic ' + Buffer.from(XENDIT_SECRET_KEY + ':').toString('base64');
}

async function xenditRequest(method, path, body) {
  const res = await fetch(`${XENDIT_BASE}${path}`, {
    method,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error_code || `HTTP ${res.status}`;
    throw new Error(`Xendit API error: ${msg}`);
  }
  return data;
}

// Get or create a Xendit customer
async function getOrCreateCustomer({ userId, email, username }) {
  const refId = `user_${userId}`;

  // Try creating first (faster path for new users)
  try {
    return await xenditRequest('POST', '/customers', {
      reference_id: refId,
      email,
      type: 'INDIVIDUAL',
      individual_detail: { given_names: username || email.split('@')[0] },
    });
  } catch (e) {
    // If duplicate, look up existing
    if (String(e.message).includes('reference_id') || String(e.message).includes('DUPLICATE')) {
      const data = await xenditRequest('GET', `/customers?reference_id=${encodeURIComponent(refId)}`);
      const existing = data?.data?.[0] || data?.[0];
      if (existing?.id) return existing;
    }
    throw e;
  }
}

// Create a recurring plan for a user
async function createRecurringPlan({ customerId, userId, email, amount, returnUrl, cancelUrl }) {
  return xenditRequest('POST', '/recurring/plans', {
    reference_id: `plan_${userId}_${Date.now()}`,
    customer_id: customerId,
    recurring_action: 'PAYMENT',
    currency: PLAN_CURRENCY,
    amount,
    schedule: {
      reference_id: `schedule_${userId}_${Date.now()}`,
      interval: 'MONTH',
      interval_count: 1,
      total_retry: 3,
      retry_interval: 'DAY',
      retry_interval_count: 3,
    },
    immediate_action_type: 'FULL_AMOUNT',
    notification_config: {
      recurring_created: ['EMAIL'],
      recurring_succeeded: ['EMAIL'],
      recurring_failed: ['EMAIL'],
    },
    failed_cycle_action: 'STOP',
    success_return_url: returnUrl,
    failure_return_url: cancelUrl,
    metadata: { user_id: userId, email },
  });
}

// Get plan details
async function getPlan(planId) {
  return xenditRequest('GET', `/recurring/plans/${planId}`);
}

// Update plan amount (for storage tier upgrades)
async function updatePlanAmount(planId, newAmount) {
  return xenditRequest('PATCH', `/recurring/plans/${planId}`, {
    amount: newAmount,
  });
}

// Deactivate (cancel) a plan
async function deactivatePlan(planId) {
  return xenditRequest('POST', `/recurring/plans/${planId}/deactivate`);
}

// Verify webhook authenticity — fail closed if token not configured
function verifyWebhook(callbackToken) {
  if (!XENDIT_CALLBACK_TOKEN || !callbackToken) return false;
  const a = Buffer.from(String(callbackToken));
  const b = Buffer.from(XENDIT_CALLBACK_TOKEN);
  if (a.length !== b.length) return false;
  return require('node:crypto').timingSafeEqual(a, b);
}

function isConfigured() {
  return Boolean(XENDIT_SECRET_KEY);
}

module.exports = {
  getOrCreateCustomer,
  createRecurringPlan,
  updatePlanAmount,
  getPlan,
  deactivatePlan,
  verifyWebhook,
  isConfigured,
  PLAN_CURRENCY,
};
