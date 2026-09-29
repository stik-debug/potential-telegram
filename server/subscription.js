/**
 * Subscription lifecycle engine — enforced server-side
 * States: TRIAL → ACTIVE → PAST_DUE → GRACE_PERIOD → SUSPENDED / EXPIRED / CANCELLED
 */
const { getDb, save, nextId, audit } = require('./db');

function getPlan(db, planId) {
  return db.plans.find(p => p.id === planId) || db.plans[0];
}

function getSubscription(db, chamaId) {
  return db.subscriptions.find(s => s.chama_id === chamaId) || null;
}

function getChamaAccess(db, chamaId) {
  const chama = db.chamas.find(c => c.id === chamaId);
  if (!chama) return { allowed: false, reason: 'CHAMA_NOT_FOUND', message: 'Chama not found' };
  if (chama.status === 'SUSPENDED') {
    return {
      allowed: false,
      reason: 'SUSPENDED',
      message: 'Your Chama account is currently suspended.',
      suspend_reason: chama.suspend_reason,
      chama,
    };
  }
  const sub = getSubscription(db, chamaId);
  if (!sub) return { allowed: false, reason: 'NO_SUBSCRIPTION', message: 'No subscription found' };

  const restricted = ['SUSPENDED', 'EXPIRED', 'CANCELLED'];
  if (restricted.includes(sub.status)) {
    return {
      allowed: false,
      reason: sub.status,
      message: sub.status === 'EXPIRED'
        ? 'Your subscription has expired.'
        : sub.status === 'SUSPENDED'
          ? 'Your subscription is suspended due to non-payment.'
          : 'Your subscription is cancelled.',
      subscription: sub,
      chama,
      amount_due: sub.amount || 500,
    };
  }
  // PAST_DUE and GRACE_PERIOD still allow read-only limited access — block writes
  return {
    allowed: true,
    write_allowed: !['PAST_DUE', 'GRACE_PERIOD'].includes(sub.status),
    reason: sub.status,
    subscription: sub,
    chama,
  };
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date((dateStr || new Date().toISOString().slice(0, 10)) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Run daily/hourly — advance PAST_DUE → GRACE → SUSPENDED */
function processExpirations(actorId = null) {
  const db = getDb();
  const settings = db.settings || {};
  const graceDays = settings.grace_days || 3;
  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;

  db.subscriptions.forEach(sub => {
    if (['CANCELLED', 'SUSPENDED'].includes(sub.status)) return;

    if (sub.status === 'TRIAL' && sub.trial_ends_at && sub.trial_ends_at < today) {
      sub.status = 'PAST_DUE';
      sub.grace_ends_at = addDays(today, graceDays);
      changed++;
      audit(db, { actor_id: actorId, action: 'SUBSCRIPTION_TRIAL_ENDED', target_type: 'subscription', target_id: sub.id, meta: { chama_id: sub.chama_id } });
      notifyAdmin(db, sub.chama_id, 'SUBSCRIPTION_EXPIRED', 'Your trial has ended. Please pay to continue.');
    }

    if (sub.status === 'ACTIVE' && sub.current_period_end && sub.current_period_end < today) {
      sub.status = 'PAST_DUE';
      sub.grace_ends_at = addDays(today, graceDays);
      changed++;
      audit(db, { actor_id: actorId, action: 'SUBSCRIPTION_PAST_DUE', target_type: 'subscription', target_id: sub.id, meta: { chama_id: sub.chama_id } });
      notifyAdmin(db, sub.chama_id, 'SUBSCRIPTION_EXPIRED', 'Your subscription has expired. Pay now to avoid suspension.');
    }

    if (sub.status === 'PAST_DUE') {
      sub.status = 'GRACE_PERIOD';
      if (!sub.grace_ends_at) sub.grace_ends_at = addDays(today, graceDays);
      changed++;
    }

    if ((sub.status === 'GRACE_PERIOD' || sub.status === 'PAST_DUE') && sub.grace_ends_at && sub.grace_ends_at < today) {
      sub.status = 'SUSPENDED';
      const chama = db.chamas.find(c => c.id === sub.chama_id);
      if (chama) {
        chama.status = 'SUSPENDED';
        chama.suspend_reason = 'Subscription payment overdue';
      }
      changed++;
      audit(db, { actor_id: actorId, action: 'SUBSCRIPTION_AUTO_SUSPENDED', target_type: 'subscription', target_id: sub.id, meta: { chama_id: sub.chama_id } });
      notifyAdmin(db, sub.chama_id, 'ACCOUNT_SUSPENDED', 'Your Chama has been suspended because the subscription remains unpaid.');
    }
  });

  if (changed) save(db);
  return changed;
}

function notifyAdmin(db, chamaId, type, body) {
  const admins = db.members.filter(m => m.chama_id === chamaId && ['CHAMA_ADMIN', 'TREASURER'].includes(m.role));
  admins.forEach(m => {
    const id = nextId(db, 'notifications');
    db.notifications.push({
      id, user_id: m.user_id, chama_id: chamaId, type, body, read: false,
      created_at: new Date().toISOString(),
    });
  });
}

/**
 * Activate/extend subscription after verified payment.
 * Idempotent if payment_id already applied.
 */
function activateFromPayment(db, { chamaId, paymentId, amount, actorId, billingMonths = 1 }) {
  const sub = getSubscription(db, chamaId);
  if (!sub) throw new Error('No subscription for chama');
  const payment = db.payments.find(p => p.id === paymentId);
  if (!payment) throw new Error('Payment not found');
  if (payment.applied_to_subscription) return { already_applied: true, subscription: sub };

  const today = new Date().toISOString().slice(0, 10);
  const base = (sub.current_period_end && sub.current_period_end > today) ? sub.current_period_end : today;
  sub.current_period_start = today;
  sub.current_period_end = addMonths(base, billingMonths);
  sub.status = 'ACTIVE';
  sub.grace_ends_at = null;
  sub.amount = amount || sub.amount;

  const chama = db.chamas.find(c => c.id === chamaId);
  if (chama) {
    chama.status = 'ACTIVE';
    chama.suspend_reason = null;
  }

  payment.applied_to_subscription = true;
  payment.status = 'SUCCESS';
  if (!payment.completed_at) payment.completed_at = new Date().toISOString();

  audit(db, {
    actor_id: actorId,
    action: 'SUBSCRIPTION_ACTIVATED',
    target_type: 'subscription',
    target_id: sub.id,
    meta: { chama_id: chamaId, payment_id: paymentId, until: sub.current_period_end },
  });

  save(db);
  return { subscription: sub, chama };
}

function suspendChama(db, { chamaId, reason, actorId, ip }) {
  const chama = db.chamas.find(c => c.id === chamaId);
  if (!chama) throw new Error('Chama not found');
  chama.status = 'SUSPENDED';
  chama.suspend_reason = reason || 'Administrative suspension';
  const sub = getSubscription(db, chamaId);
  if (sub && sub.status !== 'CANCELLED') sub.status = 'SUSPENDED';
  audit(db, {
    actor_id: actorId, action: 'CHAMA_SUSPENDED', target_type: 'chama', target_id: chamaId,
    meta: { reason: chama.suspend_reason }, ip,
  });
  save(db);
  return chama;
}

function reactivateChama(db, { chamaId, actorId, ip, extendDays }) {
  const chama = db.chamas.find(c => c.id === chamaId);
  if (!chama) throw new Error('Chama not found');
  chama.status = 'ACTIVE';
  chama.suspend_reason = null;
  const sub = getSubscription(db, chamaId);
  if (sub) {
    sub.status = 'ACTIVE';
    if (extendDays) {
      const today = new Date().toISOString().slice(0, 10);
      const base = (sub.current_period_end && sub.current_period_end > today) ? sub.current_period_end : today;
      sub.current_period_end = addDays(base, extendDays);
    }
    sub.grace_ends_at = null;
  }
  audit(db, {
    actor_id: actorId, action: 'CHAMA_REACTIVATED', target_type: 'chama', target_id: chamaId,
    meta: { extendDays: extendDays || 0, until: sub && sub.current_period_end }, ip,
  });
  save(db);
  return { chama, subscription: sub };
}

function extendSubscription(db, { chamaId, days, actorId, ip }) {
  const sub = getSubscription(db, chamaId);
  if (!sub) throw new Error('No subscription');
  const today = new Date().toISOString().slice(0, 10);
  const base = (sub.current_period_end && sub.current_period_end > today) ? sub.current_period_end : today;
  sub.current_period_end = addDays(base, days);
  if (['PAST_DUE', 'GRACE_PERIOD', 'EXPIRED', 'SUSPENDED'].includes(sub.status)) {
    sub.status = 'ACTIVE';
    const chama = db.chamas.find(c => c.id === chamaId);
    if (chama) { chama.status = 'ACTIVE'; chama.suspend_reason = null; }
  }
  sub.grace_ends_at = null;
  audit(db, {
    actor_id: actorId, action: 'SUBSCRIPTION_EXTENDED', target_type: 'subscription', target_id: sub.id,
    meta: { days, until: sub.current_period_end, chama_id: chamaId }, ip,
  });
  save(db);
  return sub;
}

function memberLimit(db, chamaId) {
  const sub = getSubscription(db, chamaId);
  const plan = sub ? getPlan(db, sub.plan_id) : getPlan(db, 1);
  const chama = db.chamas.find(c => c.id === chamaId);
  return (chama && chama.max_members) || (plan && plan.max_members) || 15;
}

module.exports = {
  getPlan, getSubscription, getChamaAccess, processExpirations,
  activateFromPayment, suspendChama, reactivateChama, extendSubscription,
  memberLimit, addMonths, addDays,
};
