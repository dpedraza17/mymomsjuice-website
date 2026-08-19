const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

// Same pagination pattern as customers-list.js — Supabase caps each
// request at 1000 rows by default, so page through in batches and combine.

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const PAGE_SIZE = 1000;
  let allSubscribers = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('newsletter_subscribers')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    allSubscribers = allSubscribers.concat(data);
    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }

  return { statusCode: 200, body: JSON.stringify({ subscribers: allSubscribers }) };
};
