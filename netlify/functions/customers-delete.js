const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

// Expects: { ids: ["uuid1", "uuid2", ...] } — works for a single id or many.

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { ids } = JSON.parse(event.body || '{}');
  if (!Array.isArray(ids) || ids.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No customer ids provided.' }) };
  }

  const { error } = await supabase.from('customers').delete().in('id', ids);

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true, deleted: ids.length }) };
};
