// Simple shared-password check used by every admin function.
// The dashboard sends the password in an "x-admin-password" header.
// Set ADMIN_PASSWORD as an environment variable in Netlify (pick something strong).

function checkAuth(event) {
  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  return provided && provided === process.env.ADMIN_PASSWORD;
}

module.exports = { checkAuth };
