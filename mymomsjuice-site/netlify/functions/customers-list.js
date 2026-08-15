const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('last_visit', { ascending: false, nullsFirst: false });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ customers: data }) };
};
