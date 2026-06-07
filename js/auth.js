/**
 * Shared Supabase auth helper — used by both app.html and dashboard.html.
 * Loads the current session, fetches the profile, and returns a normalised
 * user object.  Redirects to /login if there is no active session.
 *
 * Usage (inside a <script type="module">):
 *   import { loadUser } from '/js/auth.js';
 *   const user = await loadUser();        // redirects if not logged in
 *   console.log(user.id, user.email, user.name, user.plan);
 */

const SUPA_URL = 'https://jykqcothsmogauvfnuvh.supabase.co';
const SUPA_KEY = 'sb_publishable_5Pug_V5bF1a2j7AgR3h2xg_HRBVwC5J';

let _supabase = null;

export function getSupabase() {
  if (_supabase) return _supabase;
  const { createClient } = window.supabaseLib || {};
  if (!createClient) throw new Error('Supabase SDK not loaded');
  _supabase = createClient(SUPA_URL, SUPA_KEY);
  return _supabase;
}

/**
 * Load the authenticated user.
 * Returns a normalised user object or redirects to /login.
 */
export async function loadUser(redirectOnFail = '/login?redirect=' + encodeURIComponent(window.location.pathname)) {
  // Import Supabase dynamically so this file works without a bundler
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const supabase = createClient(SUPA_URL, SUPA_KEY);

  console.log('[EngTools:auth] loadUser — calling getSession()');
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();

  if (sessionError) {
    console.error('[EngTools:auth] getSession error:', sessionError.message);
  }

  if (!session) {
    console.warn('[EngTools:auth] No session — redirecting to', redirectOnFail);
    window.location.href = redirectOnFail;
    return null;
  }

  console.log('[EngTools:auth] Session OK | user_id:', session.user.id, '| email:', session.user.email);

  // Fetch profile — gracefully handle missing row
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, plan, monthly_reports_used, monthly_reset_date, total_reports_generated, stripe_subscription_id')
    .eq('id', session.user.id)
    .single();

  if (profileError) {
    console.warn('[EngTools:auth] Profile fetch warning:', profileError.message);
  }

  // Normalised user — name falls back to email prefix, never a fake string
  const emailPrefix = session.user.email.split('@')[0];
  const user = {
    id:                   session.user.id,
    email:                session.user.email,
    name:                 profile?.full_name || null,          // null = not set; callers use emailPrefix
    displayName:          profile?.full_name || emailPrefix,   // always a real value, never "Engineer"
    firstName:            (profile?.full_name || emailPrefix).split(' ')[0],
    plan:                 profile?.plan || 'free',
    monthly_reports_used: profile?.monthly_reports_used || 0,
    total_reports:        profile?.total_reports_generated || 0,
    monthly_reset_date:   profile?.monthly_reset_date || null,
    stripe_subscription_id: profile?.stripe_subscription_id || null,
    access_token:         session.access_token,
    is_admin:             session.user.app_metadata?.role === 'admin',
    created_at:           session.user.created_at,
    supabase,
  };

  console.log('[EngTools:auth] User loaded | displayName:', user.displayName, '| plan:', user.plan, '| token:', !!user.access_token);

  // Keep token current on auto-refresh
  supabase.auth.onAuthStateChange((event, newSession) => {
    if (newSession) {
      user.access_token = newSession.access_token;
      console.log('[EngTools:auth] Token refreshed via', event);
    }
    if (event === 'SIGNED_OUT') {
      window.location.href = '/login';
    }
  });

  return user;
}
