const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  const today = new Date().toISOString().slice(0, 10);

  const unfulfilled = [];
  const fulfilled = [];

  for (const order of data) {
    if (order.status === 'fulfilled') {
      fulfilled.push(order);
    } else {
      // Flag as "overdue" (auto-suggested fulfilled) if the due date has passed,
      // but it still requires a manual click to actually mark it fulfilled.
      order.overdue = order.due_date && order.due_date < today;
      unfulfilled.push(order);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ unfulfilled, fulfilled }),
  };
};
