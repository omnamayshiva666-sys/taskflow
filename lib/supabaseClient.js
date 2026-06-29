import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  // Don't crash the whole function file on import — log clearly instead,
  // so the real error shows up the moment an API route is actually called.
  console.warn(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ' +
    'Set them in your Vercel project → Settings → Environment Variables.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});
