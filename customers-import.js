const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

// Expects: { rows: [{ first_name, last_name, email, phone, address,
//                      first_visit, last_visit, order_count, lifetime_spend }, ...] }
//
// Matching strategy, in order:
//   1. Has an email -> upsert by email (the reliable identifier)
//   2. No email but has a phone -> upsert by phone (second-best identifier)
//   3. Neither -> plain insert (nothing to safely match against)
// This means re-running an import (e.g. after fixing a mapping bug) is safe
// and won't create duplicate customers.

function cleanPhone(raw) {
  const p = String(raw || '').trim().replace(/^'/, '');
  return p || null; // empty string -> null, so it doesn't collide with the unique constraint
}

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { rows } = JSON.parse(event.body || '{}');
  if (!Array.isArray(rows) || rows.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No rows provided.' }) };
  }

  const byEmail = new Map();
  const byPhone = new Map();
  const noIdentifier = [];

  for (const r of rows) {
    const cleaned = {
      first_name: (r.first_name || '').trim(),
      last_name: (r.last_name || '').trim(),
      email: (r.email || '').trim().toLowerCase() || null,
      phone: cleanPhone(r.phone),
      address: (r.address || '').trim(),
      first_visit: r.first_visit || null,
      last_visit: r.last_visit || null,
      order_count: parseInt(r.order_count, 10) || 0,
      lifetime_spend: parseFloat(r.lifetime_spend) || 0,
      source: r.source || 'square_import',
    };
    if (cleaned.email) byEmail.set(cleaned.email, cleaned);
    else if (cleaned.phone) byPhone.set(cleaned.phone, cleaned);
    else noIdentifier.push(cleaned);
  }

  const withEmail = Array.from(byEmail.values());
  const withPhoneOnly = Array.from(byPhone.values());

  let imported = 0;
  const errors = [];

  for (let i = 0; i < withEmail.length; i += 500) {
    const batch = withEmail.slice(i, i + 500);
    const { error } = await supabase.from('customers').upsert(batch, { onConflict: 'email' });
    if (error) errors.push(`Email batch ${i / 500 + 1}: ${error.message}`);
    else imported += batch.length;
  }

  for (let i = 0; i < withPhoneOnly.length; i += 500) {
    const batch = withPhoneOnly.slice(i, i + 500);
    const { error } = await supabase.from('customers').upsert(batch, { onConflict: 'phone' });
    if (error) errors.push(`Phone batch ${i / 500 + 1}: ${error.message}`);
    else imported += batch.length;
  }

  for (let i = 0; i < noIdentifier.length; i += 500) {
    const batch = noIdentifier.slice(i, i + 500);
    const { error } = await supabase.from('customers').insert(batch);
    if (error) errors.push(`No-identifier batch ${i / 500 + 1}: ${error.message}`);
    else imported += batch.length;
  }

  return {
    statusCode: errors.length ? 207 : 200,
    body: JSON.stringify({ imported, total: rows.length, errors }),
  };
};
