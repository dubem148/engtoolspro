import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const PRICE_IDS = {
  student: process.env.STRIPE_PRICE_STUDENT,
  pro:     process.env.STRIPE_PRICE_PRO,
  team:    process.env.STRIPE_PRICE_TEAM,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ─────────────────────────────────────────────
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Validate plan ─────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }

  const plan    = body?.plan;
  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: `Unknown plan "${plan}". Valid: student, pro, team` });

  const siteUrl = process.env.SITE_URL || 'https://engtoolspro.com';

  // ── Create Stripe checkout session ───────────────────
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

    // Reuse existing Stripe customer if present
    const { data: profile } = await admin.from('profiles').select('stripe_customer_id').eq('id', user.id).single();

    const sessionParams = {
      mode:               'subscription',
      line_items:         [{ price: priceId, quantity: 1 }],
      success_url:        `${siteUrl}/dashboard?upgraded=1`,
      cancel_url:         `${siteUrl}/app`,
      metadata:           { supabase_user_id: user.id, plan },
      subscription_data:  { metadata: { supabase_user_id: user.id, plan } },
    };

    if (profile?.stripe_customer_id) {
      sessionParams.customer = profile.stripe_customer_id;
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
