-- ============================================================
-- EngTools Pro — Supabase Database Setup
-- Run this entire file in the Supabase SQL Editor once.
-- Safe to re-run: uses IF NOT EXISTS and CREATE OR REPLACE.
-- ============================================================

-- ── 1. PROFILES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id                      UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email                   TEXT,
  full_name               TEXT,
  engineering_field       TEXT,
  plan                    TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'student' | 'pro' | 'team'
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  monthly_reports_used    INT NOT NULL DEFAULT 0,
  monthly_reset_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_reports_generated INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. REPORTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title        TEXT,
  report_type  TEXT,
  field        TEXT,
  content      TEXT,
  word_count   INT NOT NULL DEFAULT 0,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. WAITLIST ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE NOT NULL,
  source     TEXT NOT NULL DEFAULT 'landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. ROW LEVEL SECURITY ────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports  ENABLE ROW LEVEL SECURITY;

-- Drop policies first so re-runs don't error
DROP POLICY IF EXISTS "profiles_own" ON profiles;
DROP POLICY IF EXISTS "reports_select_own" ON reports;
DROP POLICY IF EXISTS "reports_insert_own" ON reports;
DROP POLICY IF EXISTS "reports_update_own" ON reports;

CREATE POLICY "profiles_own"
  ON profiles FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "reports_select_own"
  ON reports FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "reports_insert_own"
  ON reports FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "reports_update_own"
  ON reports FOR UPDATE
  USING (auth.uid() = user_id);

-- waitlist is insert-only from public (no RLS needed for anon inserts via service role)
-- Admin reads via service role which bypasses RLS.

-- ── 5. AUTO-CREATE PROFILE ON SIGNUP ────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, engineering_field)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'engineering_field'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 6. UPDATED_AT AUTO-STAMP ────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS reports_updated_at ON reports;
CREATE TRIGGER reports_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 7. INDEXES ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS reports_user_id_idx       ON reports (user_id);
CREATE INDEX IF NOT EXISTS reports_is_deleted_idx    ON reports (is_deleted);
CREATE INDEX IF NOT EXISTS reports_created_at_idx    ON reports (created_at DESC);
CREATE INDEX IF NOT EXISTS waitlist_created_at_idx   ON waitlist (created_at DESC);
