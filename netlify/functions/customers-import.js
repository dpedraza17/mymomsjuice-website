const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

// Expects: { rows: [{ first_name, last_name, email, phone, address,
//                      first_visit, last_visit, order_count, lifetime_spend }, ...] }
//
// Rows are upserted by email when an email is present. IMPORTANT: rows are
// deduplicated by email BEFORE batching — Postgres upsert fails the entire
// batch if the same email appears twice in one batch, which was silently
// dropping hundreds of customers at a time. Rows without an email are
// always inserted as new (nothing unique to match on).

function cleanPhone(raw) {
  return String(raw || '').trim().replace(/^'/, '');
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

  const withoutEmail = [];
  const byEmail = new Map(); // dedupes automatically — later rows overwrite earlier ones

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
    else withoutEmail.push(cleaned);
  }

  const withEmail = Array.from(byEmail.values());
  const duplicatesCollapsed = rows.filter(r => r.email).length - withEmail.length;

  let imported = 0;
  const errors = [];

  // Upsert in batches of 500 for anyone with an email (matches the unique index).
  // Each batch is now guaranteed to have unique emails, so one bad row can no
  // longer take down the other ~499 rows in the same batch.
  for (let i = 0; i < withEmail.length; i += 500) {
    const batch = withEmail.slice(i, i + 500);
    const { error } = await supabase
      .from('customers')
      .upsert(batch, { onConflict: 'email' });
    if (error) errors.push(`Batch ${i / 500 + 1}: ${error.message}`);
    else imported += batch.length;
  }

  // Plain insert for anyone with no email (phone-only contacts, etc).
  for (let i = 0; i < withoutEmail.length; i += 500) {
    const batch = withoutEmail.slice(i, i + 500);
    const { error } = await supabase.from('customers').insert(batch);
    if (error) errors.push(`No-email batch ${i / 500 + 1}: ${error.message}`);
    else imported += batch.length;
  }

  return {
    statusCode: errors.length ? 207 : 200,
    body: JSON.stringify({
      imported,
      total: rows.length,
      duplicatesCollapsed,
      errors,
    }),
  };
};
