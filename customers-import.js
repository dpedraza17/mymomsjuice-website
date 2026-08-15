const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

// Expects: { rows: [{ first_name, last_name, email, phone, address,
//                      first_visit, last_visit, order_count, lifetime_spend }, ...] }
//
// Matching strategy, in order:
//   1. Has an email -> upsert by email (the reliable identifier)
//   2. No email but has a phone -> match against EXISTING customers by
//      phone + first name + last name together (a bulk lookup, not a
//      database-level unique constraint — phone alone isn't reliably
//      unique since family members/businesses can share one number).
//      Matches get updated; non-matches get inserted as new.
//   3. Neither email nor phone -> nothing to safely match, just insert.
// Re-running an import is safe and won't create duplicates.

function cleanPhone(raw) {
  const p = String(raw || '').trim().replace(/^'/, '');
  return p || null;
}

function matchKey(phone, first, last) {
  return `${phone}|${(first || '').trim().toLowerCase()}|${(last || '').trim().toLowerCase()}`;
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
  const withPhoneNoEmail = [];
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
    else if (cleaned.phone) withPhoneNoEmail.push(cleaned);
    else noIdentifier.push(cleaned);
  }

  const withEmail = Array.from(byEmail.values());
  let imported = 0;
  const errors = [];

  // 1. Email-based upsert (fast, batched)
  for (let i = 0; i < withEmail.length; i += 500) {
    const batch = withEmail.slice(i, i + 500);
    const { error } = await supabase.from('customers').upsert(batch, { onConflict: 'email' });
    if (error) errors.push(`Email batch ${i / 500 + 1}: ${error.message}`);
    else imported += batch.length;
  }

  // 2. Phone-only: one bulk lookup, then batched update/insert — not one
  // request per row, which was slow enough to risk timing out.
  if (withPhoneNoEmail.length > 0) {
    const phones = [...new Set(withPhoneNoEmail.map(r => r.phone))];
    const { data: existingMatches, error: lookupError } = await supabase
      .from('customers')
      .select('id, first_name, last_name, phone')
      .in('phone', phones)
      .is('email', null);

    if (lookupError) {
      errors.push(`Phone lookup: ${lookupError.message}`);
    } else {
      const existingByKey = new Map();
      for (const c of existingMatches) {
        existingByKey.set(matchKey(c.phone, c.first_name, c.last_name), c.id);
      }

      const toUpdate = [];
      const toInsert = [];
      for (const row of withPhoneNoEmail) {
        const id = existingByKey.get(matchKey(row.phone, row.first_name, row.last_name));
        if (id) toUpdate.push({ id, ...row });
        else toInsert.push(row);
      }

      for (let i = 0; i < toUpdate.length; i += 500) {
        const batch = toUpdate.slice(i, i + 500);
        const { error } = await supabase.from('customers').upsert(batch, { onConflict: 'id' });
        if (error) errors.push(`Phone update batch ${i / 500 + 1}: ${error.message}`);
        else imported += batch.length;
      }

      for (let i = 0; i < toInsert.length; i += 500) {
        const batch = toInsert.slice(i, i + 500);
        const { error } = await supabase.from('customers').insert(batch);
        if (error) errors.push(`Phone insert batch ${i / 500 + 1}: ${error.message}`);
        else imported += batch.length;
      }
    }
  }

  // 3. No identifying info at all — nothing to safely match, just insert.
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
