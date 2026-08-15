const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const body = JSON.parse(event.body || '{}');
  const first_name = (body.first_name || '').trim();
  const last_name = (body.last_name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim();
  const address = (body.address || '').trim();

  if (!first_name && !last_name && !email && !phone) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Enter at least a name, email, or phone number.' }),
    };
  }

  // If this email already exists, update it instead of creating a duplicate.
  if (email) {
    const { data: existing } = await supabase
      .from('customers')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('customers')
        .update({ first_name, last_name, phone, address })
        .eq('id', existing.id);

      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify({ success: true, updated: true }) };
    }
  }

  const { error } = await supabase.from('customers').insert({
    first_name,
    last_name,
    email: email || null,
    phone,
    address,
    source: 'manual',
  });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
