import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Map Stripe price IDs back to plan names
function planFromPriceId(priceId) {
  const map = {
    [process.env.STRIPE_PRICE_STUDENT]: 'student',
    [process.env.STRIPE_PRICE_PRO]:     'pro',
    [process.env.STRIPE_PRICE_TEAM]:    'team',
  };
  return map[priceId] || null;
}

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  const sig    = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session    = event.data.object;
        const userId     = session.metadata?.supabase_user_id;
        const customerId = session.customer;
        const subId      = session.subscription;
        const plan       = session.metadata?.plan;

        if (userId && plan) {
          await admin.from('profiles').update({
            plan,
            stripe_customer_id:      customerId,
            stripe_subscription_id:  subId,
          }).eq('id', userId);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;

        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan    = planFromPriceId(priceId);

        if (plan) {
          await admin.from('profiles').update({
            plan,
            stripe_subscription_id: sub.id,
          }).eq('id', userId);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;

        await admin.from('profiles').update({
          plan:                   'free',
          stripe_subscription_id: null,
        }).eq('id', userId);
        break;
      }

      default:
        // Unhandled event — acknowledge receipt
        break;
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
