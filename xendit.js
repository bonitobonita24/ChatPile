// Xendit Recurring Payments API helper
// Docs: https://developers.xendit.co/api-reference

const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY || '';
const XENDIT_CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN || '';
const XENDIT_BASE = 'https://api.xendit.co';
const PLAN_AMOUNT = Number(process.env.XENDIT_PLAN_AMOUNT || 200); // $2 = 200 cents or equivalent
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

// Create a Xendit customer (required for recurring plans)
async function createCustomer({ userId, email, username }) {
  return xenditRequest('POST', '/customers', {
    reference_id: `user_${userId}`,
    email,
    type: 'INDIVIDUAL',
    individual_detail: {
      given_names: username || email.split('@')[0],
    },
  });
}

// Create a recurring plan for a user
async function createRecurringPlan({ customerId, userId, email, returnUrl, cancelUrl }) {
  return xenditRequest('POST', '/recurring/plans', {
    reference_id: `plan_${userId}`,
    customer_id: customerId,
    recurring_action: 'PAYMENT',
    currency: PLAN_CURRENCY,
    amount: PLAN_AMOUNT,
    schedule: {
      reference_id: `schedule_${userId}`,
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

// Look up existing customer by reference_id
async function getCustomerByRef(referenceId) {
  const data = await xenditRequest('GET', `/customers?reference_id=${encodeURIComponent(referenceId)}`);
  return data?.data?.[0] || data?.[0] || null;
}

// Get plan details
async function getPlan(planId) {
  return xenditRequest('GET', `/recurring/plans/${planId}`);
}

// Deactivate (cancel) a plan
async function deactivatePlan(planId) {
  return xenditRequest('POST', `/recurring/plans/${planId}/deactivate`);
}

// Verify webhook authenticity
function verifyWebhook(callbackToken) {
  if (!XENDIT_CALLBACK_TOKEN) return true; // skip verification if not configured
  return callbackToken === XENDIT_CALLBACK_TOKEN;
}

function isConfigured() {
  return Boolean(XENDIT_SECRET_KEY);
}

module.exports = {
  createCustomer,
  getCustomerByRef,
  createRecurringPlan,
  getPlan,
  deactivatePlan,
  verifyWebhook,
  isConfigured,
  PLAN_AMOUNT,
  PLAN_CURRENCY,
};
