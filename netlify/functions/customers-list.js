const { supabase } = require('./_supabase');
const { checkAuth } = require('./_auth');

// Supabase caps each request at 1000 rows by default, so we page through
// in batches of 1000 and combine them into one full list.

exports.handler = async (event) => {
  if (!checkAuth(event)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const PAGE_SIZE = 1000;
  let allCustomers = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('last_visit', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true }) // stable tiebreaker so paging never repeats/skips rows with the same last_visit
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    allCustomers = allCustomers.concat(data);
    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }

  return { statusCode: 200, body: JSON.stringify({ customers: allCustomers }) };
};
