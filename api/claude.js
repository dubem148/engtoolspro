import { createClient } from '@supabase/supabase-js';

const PLAN_LIMITS = { free: 10, student: 150, pro: -1, team: -1 };

function isSameMonth(dateA, dateB) {
  return dateA.getFullYear() === dateB.getFullYear() &&
         dateA.getMonth()    === dateB.getMonth();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ─────────────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required. Please sign in.' });

  const supabaseUrl    = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey   = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !serviceRoleKey) return res.status(500).json({ error: 'Server misconfiguration' });
  if (!anthropicKey)                   return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });

  // ── Rate limiting ─────────────────────────────────────────────
  const { data: profile } = await admin
    .from('profiles')
    .select('plan, monthly_reports_used, monthly_reset_date, total_reports_generated')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(500).json({ error: 'Could not load user profile' });

  const plan  = profile.plan || 'free';
  const limit = PLAN_LIMITS[plan] ?? 10;
  const now   = new Date();

  let used      = profile.monthly_reports_used || 0;
  let resetDate = new Date(profile.monthly_reset_date || now);

  // Reset counter when calendar month rolls over
  if (!isSameMonth(resetDate, now)) {
    used      = 0;
    resetDate = now;
    await admin.from('profiles')
      .update({ monthly_reports_used: 0, monthly_reset_date: now.toISOString() })
      .eq('id', user.id);
  }

  if (limit !== -1 && used >= limit) {
    return res.status(429).json({
      error: `Monthly limit reached (${limit} reports on the ${plan} plan). Upgrade to continue.`,
      limit,
      used,
      plan
    });
  }

  // ── Validate + forward request ────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  if (!body) return res.status(400).json({ error: 'Empty request body' });

  body = { ...body, model: 'claude-sonnet-4-6' };

  const bodyStr = JSON.stringify(body);
  if (bodyStr.length > 500_000) return res.status(413).json({ error: 'Request payload too large' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: bodyStr
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error', response.status, JSON.stringify(data));
      return res.status(response.status).json({
        error: data.error?.message || 'Anthropic API error',
        anthropic_error: data
      });
    }

    // Increment usage counter on success
    await admin.from('profiles').update({
      monthly_reports_used:    used + 1,
      total_reports_generated: (profile.total_reports_generated || 0) + 1
    }).eq('id', user.id);

    return res.status(200).json(data);

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
