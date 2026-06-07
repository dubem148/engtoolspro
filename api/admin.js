import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

async function requireAdmin(req, admin) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return null;
  // Role is stored in app_metadata — only writable by service role, never by users
  if (user.app_metadata?.role !== 'admin') return null;
  return user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const user = await requireAdmin(req, admin);
  if (!user) return res.status(403).json({ error: 'Forbidden' });

  try {
    // ── Supabase stats ──────────────────────────────────
    const [totalUsersRes, activeSubsRes, totalReportsRes, waitlistRes] = await Promise.all([
      admin.from('profiles').select('id', { count: 'exact', head: true }),
      admin.from('profiles').select('id', { count: 'exact', head: true }).neq('plan', 'free'),
      admin.from('reports').select('id',  { count: 'exact', head: true }).eq('is_deleted', false),
      admin.from('waitlist').select('id', { count: 'exact', head: true }),
    ]);

    // ── Recent signups (last 30) ────────────────────────
    const { data: recentUsers } = await admin
      .from('profiles')
      .select('email, full_name, plan, created_at')
      .order('created_at', { ascending: false })
      .limit(30);

    // ── Stripe revenue ──────────────────────────────────
    let mrr = 0, arr = 0, recentPayments = [];

    if (process.env.STRIPE_SECRET_KEY) {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

      const [subs, charges] = await Promise.all([
        stripe.subscriptions.list({ status: 'active', limit: 100, expand: ['data.items.data.price'] }),
        stripe.paymentIntents.list({ limit: 20 })
      ]);

      mrr = subs.data.reduce((sum, sub) => {
        const price = sub.items?.data?.[0]?.price;
        if (!price) return sum;
        const amount = price.unit_amount / 100;
        return sum + (price.recurring?.interval === 'year' ? amount / 12 : amount);
      }, 0);
      arr = mrr * 12;

      recentPayments = charges.data
        .filter(pi => pi.status === 'succeeded')
        .map(pi => ({
          amount:   (pi.amount / 100).toFixed(2),
          currency: pi.currency.toUpperCase(),
          created:  new Date(pi.created * 1000).toISOString(),
          email:    pi.receipt_email || '—',
        }));
    }

    return res.status(200).json({
      total_users:          totalUsersRes.count  || 0,
      active_subscriptions: activeSubsRes.count  || 0,
      total_reports:        totalReportsRes.count|| 0,
      waitlist_count:       waitlistRes.count    || 0,
      mrr:                  mrr.toFixed(2),
      arr:                  arr.toFixed(2),
      recent_payments:      recentPayments,
      recent_users:         recentUsers || [],
    });

  } catch (err) {
    console.error('Admin error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
