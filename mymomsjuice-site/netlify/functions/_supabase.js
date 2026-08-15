// Shared Supabase client for all admin functions.
// Requires these environment variables set in Netlify:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (the "service_role" key, NOT the public anon key —
//                            this runs server-side only, never expose it to the browser)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = { supabase };
