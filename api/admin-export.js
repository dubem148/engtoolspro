import { createClient } from '@supabase/supabase-js';

async function requireAdmin(req, admin) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return null;
  if (user.email !== process.env.ADMIN_EMAIL) return null;
  return user;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const user = await requireAdmin(req, admin);
  if (!user) return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await admin
    .from('waitlist')
    .select('email, source, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const header = 'email,source,created_at\n';
  const rows   = (data || []).map(r =>
    `"${r.email}","${r.source}","${r.created_at}"`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="waitlist.csv"');
  return res.status(200).send(header + rows);
}
