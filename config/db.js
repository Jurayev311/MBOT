require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL va SUPABASE_SERVICE_KEY .env faylida kiritilishi kerak.');
}

// Backend service_role kaliti bilan ishlaydi, shu sabab sessiya saqlash kerak emas.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = { supabase };
