const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { orderId, fulfilled } = JSON.parse(event.body || '{}');
  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'orderId is required' }) };
  }

  const { error } = await supabase
    .from('orders')
    .update({
      status: fulfilled === false ? 'unfulfilled' : 'fulfilled',
      fulfilled_at: fulfilled === false ? null : new Date().toISOString(),
    })
    .eq('id', orderId);

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
