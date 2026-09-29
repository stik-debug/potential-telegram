const { getDb, save, nextId, audit } = require('./db');

function getPlan(db, planId) {
  return db.plans.find(p => p.id === planId) || db.plans[0];
}

function getSubscription(db, chamaId) {
  return db.subscriptions.find(s => s.chama_id === chamaId) || null;
}

function memberLimit(db, chamaId) {
  const sub = getSubscription(db, chamaId);
  const plan = sub ? getPlan(db, sub.plan_id) : getPlan(db, 1);
  const chama = db.chamas.find(c => c.id === chamaId);
  return (chama && chama.max_members) || (plan && plan.max_members) || 15;
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
  const subscription = getSubscription(db, chamaId);
  if (!subscription) return { allowed: false, reason: 'NO_SUBSCRIPTION', message: 'No subscription found', chama };
  if (['SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(subscription.status)) {
    return {
      allowed: false,
      reason: subscription.status,
      message: 'Your subscription is ' + subscription.status.toLowerCase() + '. Pay or contact support.',
      subscription,
      chama,
      amount_due: subscription.amount || 500,
    };
  }
  return {
    allowed: true,
    write_allowed: !['PAST_DUE', 'GRACE_PERIOD'].includes(subscription.status),
    reason: subscription.status,
    subscription,
    chama,
  };
}

function addDays(dateStr, days) {
  const d = new Date((dateStr || new Date().toISOString().slice(0, 10)) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function processExpirations(actorId) {
  const db = getDb();
  const graceDays = (db.settings && db.settings.grace_days) || 3;
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  db.subscriptions.forEach(sub => {
    if (['CANCELLED', 'SUSPENDED'].includes(sub.status)) return;
    if (sub.status === 'TRIAL' && sub.trial_ends_at && sub.trial_ends_at < today) {
      sub.status = 'PAST_DUE';
      sub.grace_ends_at = addDays(today, graceDays);
      n++;
    }
    if (sub.status === 'ACTIVE' && sub.current_period_end && sub.current_period_end < today) {
      sub.status = 'PAST_DUE';
      sub.grace_ends_at = addDays(today, graceDays);
      n++;
    }
    if (sub.status === 'PAST_DUE') {
      sub.status = 'GRACE_PERIOD';
      if (!sub.grace_ends_at) sub.grace_ends_at = addDays(today, graceDays);
      n++;
    }
    if (['GRACE_PERIOD', 'PAST_DUE'].includes(sub.status) && sub.grace_ends_at && sub.grace_ends_at < today) {
      sub.status = 'SUSPENDED';
      const c = db.chamas.find(x => x.id === sub.chama_id);
      if (c) {
        c.status = 'SUSPENDED';
        c.suspend_reason = 'Subscription payment overdue';
      }
      n++;
    }
  });
  if (n) save(db);
  return n;
}

function suspendChama(db, { chamaId, reason, actorId, ip }) {
  const chama = db.chamas.find(c => c.id === chamaId);
  if (!chama) throw new Error('Chama not found');
  chama.status = 'SUSPENDED';
  chama.suspend_reason = reason || 'Administrative suspension';
  const sub = getSubscription(db, chamaId);
  if (sub && sub.status !== 'CANCELLED') sub.status = 'SUSPENDED';
  audit(db, { actor_id: actorId, action: 'CHAMA_SUSPENDED', target_type: 'chama', target_id: chamaId, meta: { reason: chama.suspend_reason }, ip });
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
      const base = sub.current_period_end && sub.current_period_end > today ? sub.current_period_end : today;
      sub.current_period_end = addDays(base, extendDays);
    }
    sub.grace_ends_at = null;
  }
  audit(db, { actor_id: actorId, action: 'CHAMA_REACTIVATED', target_type: 'chama', target_id: chamaId, meta: { extendDays: extendDays || 0 }, ip });
  save(db);
  return { chama, subscription: sub };
}

function extendSubscription(db, { chamaId, days, actorId, ip }) {
  const sub = getSubscription(db, chamaId);
  if (!sub) throw new Error('No subscription');
  const today = new Date().toISOString().slice(0, 10);
  const base = sub.current_period_end && sub.current_period_end > today ? sub.current_period_end : today;
  sub.current_period_end = addDays(base, days);
  if (['PAST_DUE', 'GRACE_PERIOD', 'EXPIRED', 'SUSPENDED'].includes(sub.status)) {
    sub.status = 'ACTIVE';
    const c = db.chamas.find(x => x.id === chamaId);
    if (c) { c.status = 'ACTIVE'; c.suspend_reason = null; }
  }
  sub.grace_ends_at = null;
  audit(db, { actor_id: actorId, action: 'SUBSCRIPTION_EXTENDED', target_type: 'subscription', target_id: sub.id, meta: { days, chama_id: chamaId }, ip });
  save(db);
  return sub;
}

function activateFromPayment(db, { chamaId, paymentId, amount, actorId }) {
  const sub = getSubscription(db, chamaId);
  if (!sub) throw new Error('No subscription');
  const payment = db.payments.find(p => p.id === paymentId);
  if (!payment) throw new Error('Payment not found');
  if (payment.applied_to_subscription) return { already_applied: true, subscription: sub };
  const today = new Date().toISOString().slice(0, 10);
  const base = sub.current_period_end && sub.current_period_end > today ? sub.current_period_end : today;
  sub.current_period_start = today;
  sub.current_period_end = addMonths(base, 1);
  sub.status = 'ACTIVE';
  sub.grace_ends_at = null;
  sub.amount = amount || sub.amount;
  const chama = db.chamas.find(c => c.id === chamaId);
  if (chama) { chama.status = 'ACTIVE'; chama.suspend_reason = null; }
  payment.applied_to_subscription = true;
  payment.status = 'SUCCESS';
  if (!payment.completed_at) payment.completed_at = new Date().toISOString();
  audit(db, { actor_id: actorId, action: 'SUBSCRIPTION_ACTIVATED', target_type: 'subscription', target_id: sub.id, meta: { chama_id: chamaId, payment_id: paymentId } });
  save(db);
  return { subscription: sub, chama };
}

module.exports = {
  getPlan, getSubscription, getChamaAccess, memberLimit, processExpirations,
  suspendChama, reactivateChama, extendSubscription, activateFromPayment, addDays, addMonths,
};
