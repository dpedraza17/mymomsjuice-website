// My Mom's Juice — Stripe Checkout backend
// Creates a single Stripe Checkout Session that can contain many different
// line items (loose bottles, 6-packs, detox cleanses, immunity shots) in
// ONE transaction, with server-side pricing so nothing can be tampered with
// from the browser.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY in your environment (.env file).');
  process.exit(1);
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL || 'http://localhost:8080';
const PORT = process.env.PORT || 4242;

// --- Supabase (powers the admin dashboard) --------------------------------
// If these aren't set yet, order-saving is skipped (logged as a warning)
// but everything else — checkout, email notifications — still works.
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const app = express();
// Render (and most hosts) sit behind a reverse proxy, which adds an
// X-Forwarded-For header with the real visitor IP. Without telling Express
// to trust that proxy, express-rate-limit can't safely read the real IP and
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR instead of working normally.
app.set('trust proxy', 1);
// Only these origins may call this backend from a browser. Comma-separate
// multiple values in CORS_ORIGIN if needed (e.g. with/without "www").
// Falls back to SITE_URL if CORS_ORIGIN isn't set. Requests with no Origin
// header at all (curl, server-to-server calls, and some local file:// pages)
// are always allowed since there's no browser cross-site risk there.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || SITE_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === 'null' || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS: ' + origin));
  },
}));
// ---------------------------------------------------------------------------
// ORDER NOTIFICATIONS
//
// When a payment actually succeeds, Stripe calls this webhook and we email
// you the order details. This is separate from checkout session CREATION —
// a session being created doesn't mean anyone paid; this webhook only fires
// once money has actually changed hands, which is what you want to be
// notified about.
//
// Setup required (see README): a Stripe webhook pointed at this endpoint,
// and a Resend account + API key for sending the email.
// ---------------------------------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const NOTIFY_FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'onboarding@resend.dev';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function sendOrderNotificationEmail(session) {
  if (!RESEND_API_KEY || !OWNER_EMAIL) {
    console.warn('RESEND_API_KEY or OWNER_EMAIL not set — skipping order notification email.');
    return;
  }

  const md = session.metadata || {};
  const amount = ((session.amount_total || 0) / 100).toFixed(2);
  const modeRaw = (md.order_mode || '').toLowerCase();
  const orderMode = modeRaw.includes('deliver') ? 'delivery'
    : modeRaw.includes('pop') ? 'popup'
    : 'pickup';
  const { fulfillment_estimate } = getFulfillmentEstimate(orderMode);

  let emailItems;
  try {
    const parsed = JSON.parse(md.structured_items || '[]');
    emailItems = Array.isArray(parsed) && parsed.length
      ? parsed.map(i => {
          const qty = i.qty || 1;
          const label = `${qty}× ${i.name}`;
          const lineTotal = (typeof i.price === 'number')
            ? `$${((i.price * qty) / 100).toFixed(2)}`
            : '';
          return `<tr><td style="padding:3px 12px 3px 0;">${label}</td><td style="padding:3px 0; text-align:right;">${lineTotal}</td></tr>`;
        }).join('')
      : `<tr><td>${md.order_summary || 'n/a'}</td></tr>`;
  } catch {
    emailItems = `<tr><td>${md.order_summary || 'n/a'}</td></tr>`;
  }

  const html = `
    <h2>New order — $${amount}</h2>
    <p><strong>Customer:</strong> ${md.customer_name || 'n/a'}</p>
    <p><strong>Phone:</strong> ${md.customer_phone || 'n/a'}</p>
    <p><strong>Email:</strong> ${session.customer_details?.email || session.customer_email || 'n/a'}</p>
    <p><strong>Mode:</strong> ${md.order_mode || 'n/a'}</p>
    <p><strong>Fulfillment:</strong> ${fulfillment_estimate}</p>
    ${md.delivery_address ? `<p><strong>Delivery address:</strong> ${md.delivery_address}</p>` : ''}
    ${md.customer_note ? `<p><strong>Note from customer:</strong> ${md.customer_note}</p>` : ''}
    <p><strong>Order:</strong></p>
    <table style="border-collapse:collapse; font-size:14px;">
      ${emailItems}
      <tr><td style="padding:6px 12px 0 0; border-top:1px solid #ccc; font-weight:bold;">Total paid</td><td style="padding:6px 0 0; border-top:1px solid #ccc; text-align:right; font-weight:bold;">$${amount}</td></tr>
    </table>
    <p><strong>Stripe session:</strong> ${session.id}</p>
  `;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `My Mom's Juice Orders <${NOTIFY_FROM_EMAIL}>`,
        to: [OWNER_EMAIL],
        subject: `New order — $${amount} (${md.order_mode || ''})`,
        html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend email failed:', resp.status, errText);
    }
  } catch (err) {
    console.error('Error sending order notification email:', err.message);
  }
}

// ---------------------------------------------------------------------------
// CUSTOMER-FACING ORDER CONFIRMATION EMAIL
//
// Same trigger as the owner notification above (checkout.session.completed).
// Reuses getFulfillmentEstimate() so the date shown here always matches
// what the customer saw at checkout and what shows in the dashboard —
// nothing here is calculated independently.
// ---------------------------------------------------------------------------
function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildFulfillmentCardHtml(orderMode, fulfillmentEstimate) {
  if (orderMode === 'pickup') {
    return `
        <tr>
          <td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EFF3E4; border-radius:8px;">
              <tr>
                <td style="padding:14px 16px;">
                  <p style="margin:0 0 4px; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#5F7A3A; font-weight:bold;">Pickup &mdash; Mesa</p>
                  <p style="margin:0 0 2px; font-size:14px; color:#2F3B2A;">The Kitchen's Market</p>
                  <p style="margin:0 0 6px; font-size:13px; color:#5A5A52;">2655 W Guadalupe Rd Suite 13, Mesa, AZ</p>
                  <p style="margin:0 0 4px; font-size:14px; color:#2F3B2A; font-weight:bold;">${esc(fulfillmentEstimate)}</p>
                  <p style="margin:0; font-size:13px; color:#5A5A52;">Fri 8am&ndash;5pm &middot; Sat 8am&ndash;3pm &middot; Sun 10am&ndash;3pm</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
  }
  if (orderMode === 'popup') {
    return `
        <tr>
          <td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EFF3E4; border-radius:8px;">
              <tr>
                <td style="padding:14px 16px;">
                  <p style="margin:0 0 4px; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#5F7A3A; font-weight:bold;">Pop-up &mdash; 83rd Ave &amp; McDowell</p>
                  <p style="margin:0 0 6px; font-size:13px; color:#5A5A52;">8367 W McDowell Rd, Tolleson, AZ</p>
                  <p style="margin:0 0 4px; font-size:14px; color:#2F3B2A; font-weight:bold;">${esc(fulfillmentEstimate)}</p>
                  <p style="margin:0; font-size:13px; color:#5A5A52;">Sat &amp; Sun 8am&ndash;12pm</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
  }
  // delivery
  return `
        <tr>
          <td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FBEFE2; border-radius:8px; border:1px solid #F0D9BC;">
              <tr>
                <td style="padding:16px 20px;">
                  <p style="margin:0 0 4px; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#B25E1E; font-weight:bold;">Delivery</p>
                  <p style="margin:0 0 8px; font-size:14px; color:#2F3B2A; font-weight:bold;">${esc(fulfillmentEstimate)}</p>
                  <p style="margin:0 0 2px; font-size:13px; color:#2F3B2A;">East Valley: 9am&ndash;12pm</p>
                  <p style="margin:0 0 2px; font-size:13px; color:#2F3B2A;">South/North/Central Phoenix: 11am&ndash;3pm</p>
                  <p style="margin:0 0 8px; font-size:13px; color:#2F3B2A;">West Valley: 1pm&ndash;4pm</p>
                  <p style="margin:0; font-size:12px; color:#8A8A80; line-height:1.5;">These are estimates &mdash; we'll text you when we're on the way. You'll need to be present at delivery.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
}

function buildCustomerConfirmationEmailHtml(session) {
  const md = session.metadata || {};
  const amount = session.amount_total || 0;
  const modeRaw = (md.order_mode || '').toLowerCase();
  const orderMode = modeRaw.includes('deliver') ? 'delivery'
    : modeRaw.includes('pop') ? 'popup'
    : 'pickup';
  const { fulfillment_estimate } = getFulfillmentEstimate(orderMode);
  const firstName = (md.customer_name || '').split(' ')[0] || 'there';
  // No sequential order number exists in this system yet — use the tail of
  // the Stripe session id as a short, stable reference the customer can
  // quote if they text in with a question.
  const orderRef = session.id ? session.id.slice(-8).toUpperCase() : '';

  let items = [];
  try {
    const parsed = JSON.parse(md.structured_items || '[]');
    items = Array.isArray(parsed) && parsed.length ? parsed : [{ name: md.order_summary || 'Order', qty: 1 }];
  } catch {
    items = [{ name: md.order_summary || 'Order', qty: 1 }];
  }

  const itemsRows = items.map((item, i) => {
    const isLast = i === items.length - 1;
    const borderStyle = isLast ? '' : 'border-bottom:1px solid #EDE3CE;';
    const label = item.qty && item.qty > 1 ? `${item.qty}&times; ${esc(item.name)}` : esc(item.name);
    // Older orders placed before per-item pricing was added won't have a
    // price field — fall back to blank rather than showing a false $0.00.
    const priceCell = (typeof item.price === 'number')
      ? money(item.price * (item.qty || 1))
      : '';
    return `
                    <tr>
                      <td style="padding:8px 0; ${borderStyle} font-size:14px; color:#2F3B2A;">${label}</td>
                      <td style="padding:8px 0; ${borderStyle} font-size:14px; color:#2F3B2A; text-align:right;">${priceCell}</td>
                    </tr>`;
  }).join('');

  const noteBlock = md.customer_note ? `
        <tr>
          <td style="padding:18px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF6EE; border-radius:8px; border:1px dashed #DCCFA8;">
              <tr>
                <td style="padding:14px 16px;">
                  <p style="margin:0 0 4px; font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#8A9B6E; font-weight:bold;">Your note</p>
                  <p style="margin:0; font-size:14px; color:#2F3B2A; line-height:1.5;">${esc(md.customer_note)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Order Confirmation</title>
</head>
<body style="margin:0; padding:0; background-color:#F3EEE4; font-family: Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3EEE4; padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:#FFFFFF; border-radius:12px; overflow:hidden; border:1px solid #E5DCC9;">

        <tr>
          <td style="background-color:#E8792F; padding:28px 32px; text-align:center;">
            <p style="margin:0; font-size:13px; letter-spacing:1.5px; text-transform:uppercase; color:#FCE9D8; font-weight:bold;">My Mom's Juice</p>
            <h1 style="margin:6px 0 0; font-size:22px; color:#FFFFFF; font-weight:bold;">Order confirmed</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0 0 4px; font-size:16px; color:#2F3B2A;">Hi ${esc(firstName)},</p>
            <p style="margin:0; font-size:15px; color:#5A5A52; line-height:1.55;">Thanks for your order! We're getting it ready. Here's a summary of what you ordered.</p>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF6EE; border-radius:8px; border:1px solid #EDE3CE;">
              <tr>
                <td style="padding:18px 20px 6px;">
                  <p style="margin:0; font-size:12px; letter-spacing:0.6px; text-transform:uppercase; color:#8A9B6E; font-weight:bold;">Order #${esc(orderRef)}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 20px 4px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemsRows}
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 20px 18px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-top:10px; border-top:1px solid #E0D3B0; font-size:15px; color:#2F3B2A; font-weight:bold;">Total</td>
                      <td style="padding-top:10px; border-top:1px solid #E0D3B0; font-size:15px; color:#2F3B2A; font-weight:bold; text-align:right;">${money(amount)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
${buildFulfillmentCardHtml(orderMode, fulfillment_estimate)}
${noteBlock}

        <tr>
          <td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#E8792F; border-radius:8px;">
              <tr>
                <td style="padding:18px 20px; text-align:center;">
                  <p style="margin:0; font-size:17px; color:#FFFFFF; font-weight:bold;">Questions about your order?</p>
                  <p style="margin:6px 0 0; font-size:20px;"><a href="sms:+14808750690" style="color:#FFFFFF; text-decoration:underline;">Text us at 480-875-0690</a></p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:22px 32px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #EDE3CE;">
              <tr>
                <td style="padding-top:18px; text-align:center;">
                  <p style="margin:0 0 4px; font-size:13px; color:#2F3B2A; font-weight:bold;">My Mom's Juice</p>
                  <p style="margin:0; font-size:12px; color:#8A8A80;">2655 W Guadalupe Rd Suite 13, Mesa, AZ</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

async function sendCustomerConfirmationEmail(session) {
  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!RESEND_API_KEY || !customerEmail) {
    console.warn('RESEND_API_KEY not set or no customer email — skipping customer confirmation email.');
    return;
  }

  const html = buildCustomerConfirmationEmailHtml(session);

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `My Mom's Juice <${NOTIFY_FROM_EMAIL}>`,
        to: [customerEmail],
        subject: `Order confirmed — My Mom's Juice`,
        html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend customer confirmation email failed:', resp.status, errText);
    }
  } catch (err) {
    console.error('Error sending customer confirmation email:', err.message);
  }
}


//
// Same trigger as the email above — only runs once payment has actually
// succeeded. Matches/creates the customer by email, then records the order.
// ---------------------------------------------------------------------------

// Figures out the order's fulfillment estimate — using the EXACT same
// cutoff rules as the homepage's own estimate display, so what shows in
// the dashboard always matches what the customer actually saw at checkout.
// All calculated in Arizona time (America/Phoenix, no DST), same as the site.

function azNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
}

// Delivery: Tue & Fri runs. Tue/Wed/Thu orders -> this Friday.
// Fri/Sat/Sun/Mon orders -> next Tuesday.
function nextDelivery() {
  const now = azNow();
  const dow = now.getDay();
  const targetDow = (dow === 2 || dow === 3 || dow === 4) ? 5 : 2;
  let daysAhead = (targetDow - dow + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  const target = new Date(now);
  target.setDate(now.getDate() + daysAhead);
  const dayName = target.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = target.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return { date: target, label: `${dayName}, ${dateStr}` };
}

// Pickup: Fri–Sun in Mesa. Cutoff Thursday 11:59pm AZ time.
function nextPickup() {
  const now = azNow();
  const dow = now.getDay();
  let daysAhead = (5 - dow + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + daysAhead);
  const saturday = new Date(friday); saturday.setDate(friday.getDate() + 1);
  const sunday = new Date(friday); sunday.setDate(friday.getDate() + 2);
  const friMonth = friday.toLocaleDateString('en-US', { month: 'long' });
  const satMonth = saturday.toLocaleDateString('en-US', { month: 'long' });
  const sunMonth = sunday.toLocaleDateString('en-US', { month: 'long' });
  const friStr = `${friMonth} ${friday.getDate()}`;
  const satStr = (satMonth === friMonth) ? `${saturday.getDate()}` : `${satMonth} ${saturday.getDate()}`;
  const sunStr = (sunMonth === friMonth) ? `${sunday.getDate()}` : `${sunMonth} ${sunday.getDate()}`;
  return { date: friday, label: `Friday, Saturday, or Sunday — ${friStr}–${sunStr}` };
}

// Weekend pop-up (83rd Ave & McDowell): Sat–Sun. Cutoff Thursday 11:59pm AZ time.
function nextPopup() {
  const now = azNow();
  const dow = now.getDay();
  let daysAhead = (6 - dow + 7) % 7;
  if (dow === 5 || dow === 6) daysAhead += 7;
  const saturday = new Date(now);
  saturday.setDate(now.getDate() + daysAhead);
  const sunday = new Date(saturday); sunday.setDate(saturday.getDate() + 1);
  const satMonth = saturday.toLocaleDateString('en-US', { month: 'long' });
  const sunMonth = sunday.toLocaleDateString('en-US', { month: 'long' });
  const satStr = `${satMonth} ${saturday.getDate()}`;
  const sunStr = (sunMonth === satMonth) ? `${sunday.getDate()}` : `${sunMonth} ${sunday.getDate()}`;
  return { date: saturday, label: `Saturday or Sunday — ${satStr}–${sunStr}` };
}

function getFulfillmentEstimate(mode) {
  const result = mode === 'delivery' ? nextDelivery()
    : mode === 'popup' ? nextPopup()
    : nextPickup(); // default/pickup
  return {
    due_date: result.date.toISOString().slice(0, 10),
    fulfillment_estimate: result.label,
  };
}

async function saveOrderToDatabase(session) {
  if (!supabase) {
    console.warn('SUPABASE_URL/SUPABASE_SERVICE_KEY not set — skipping order save to database.');
    return;
  }

  const md = session.metadata || {};
  const email = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const [firstName = '', ...rest] = (md.customer_name || '').split(' ');
  const lastName = rest.join(' ');
  const phone = md.customer_phone || '';
  const address = md.delivery_address || '';
  const total = (session.amount_total || 0) / 100;
  // order_mode in metadata is currently a human label (e.g. "Pickup (Mesa)");
  // normalize it back to pickup/delivery/popup for the estimate logic.
  const modeRaw = (md.order_mode || '').toLowerCase();
  const orderMode = modeRaw.includes('deliver') ? 'delivery'
    : modeRaw.includes('pop') ? 'popup'
    : 'pickup';
  const today = new Date().toISOString().slice(0, 10);
  const { due_date, fulfillment_estimate } = getFulfillmentEstimate(orderMode);

  let items;
  try {
    const parsed = JSON.parse(md.structured_items || '[]');
    items = Array.isArray(parsed) && parsed.length ? parsed : [{ name: md.order_summary || 'Order', qty: 1 }];
  } catch {
    items = [{ name: md.order_summary || 'Order', qty: 1 }];
  }

  // 1. Find or create the customer (matched by email)
  let customerId = null;
  if (email) {
    const { data: existing } = await supabase
      .from('customers')
      .select('id, order_count, lifetime_spend')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      await supabase.from('customers').update({
        first_name: firstName,
        last_name: lastName,
        phone,
        address: address || undefined,
        order_count: (existing.order_count || 0) + 1,
        lifetime_spend: Number(existing.lifetime_spend || 0) + total,
        last_visit: today,
      }).eq('id', existing.id);
      customerId = existing.id;
    } else {
      const { data: created, error } = await supabase.from('customers').insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        address,
        order_count: 1,
        lifetime_spend: total,
        first_visit: today,
        last_visit: today,
        source: 'website',
      }).select('id').single();
      if (error) console.error('Error creating customer:', error.message);
      customerId = created?.id || null;
    }
  }

  // 2. Save the order itself
  const { error: orderError } = await supabase.from('orders').insert({
    customer_id: customerId,
    customer_name: md.customer_name || '',
    customer_email: email,
    customer_phone: phone,
    order_type: orderMode,
    items,
    total,
    due_date,
    fulfillment_estimate,
    customer_note: md.customer_note || '',
    status: 'unfulfilled',
    stripe_session_id: session.id,
  });
  if (orderError) console.error('Error saving order:', orderError.message);
}

// Stripe requires the RAW request body (not JSON-parsed) to verify the
// webhook signature, so this route is registered with express.raw()
// BEFORE the global express.json() middleware below.
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // No webhook secret configured yet — accept unverified (fine for local
      // testing only; set STRIPE_WEBHOOK_SECRET before going live).
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await Promise.all([
      sendOrderNotificationEmail(session),
      sendCustomerConfirmationEmail(session),
      saveOrderToDatabase(session),
    ]);
  }

  res.json({ received: true });
});

app.use(express.json());



// ---------------------------------------------------------------------------
// SERVER-SIDE PRICE TABLE — the source of truth. The browser never gets to
// decide what anything costs; it only tells us WHAT was ordered, and we look
// up the price ourselves. Keep this in sync with the menu on the website.
// ---------------------------------------------------------------------------
const MENU_ITEMS = {
  green:          { name: 'Green Juice',                 price: 700 },
  vampiro:        { name: 'El Vampiro',                   price: 700 },
  mimosa:         { name: 'Mimosa Juice',                 price: 700 },
  sunrise:        { name: 'Citrus Sunrise',                price: 700 },
  grapefruit:     { name: 'Fresh Grapefruit',              price: 700 },
  sonsfav:        { name: "The Son's Favorite",            price: 700 },
  watermelon:     { name: 'Watermelon Water',               price: 700 },
  pepino:         { name: 'Agua de Pepino con Limón',        price: 700 },
  horchatalatte:  { name: 'Horchata Latte',                 price: 700 },
  horchata:       { name: "My Mom's Horchata",              price: 700 },
  chatamatcha:    { name: 'Chata Matcha',                    price: 700 },
  strawhorchata:  { name: 'Strawberry Horchata',             price: 700 },
  stlemonade:     { name: 'Strawberry Lemonade',             price: 700 },
};

const SIXPACK_PRICE = 3600; // $36.00
const SHOT_PRICE_REGULAR = 500; // $5.00 each
const SHOT_PRICE_BULK = 400;    // $4.00 each, 5 or more
const SHOT_BULK_THRESHOLD = 5;

// Matches DELIVERY_FEE in index.html — keep these in sync.
const DELIVERY_FEE = 600; // $6.00, delivery orders only

// Custom tip amounts come from the customer, not looked up from a price
// table, so there's no "correct" value to validate against the way there
// is for items. We still cap it so a typo or bad-faith request can't create
// a wildly oversized Stripe charge.
const MAX_CUSTOM_TIP = 50000; // $500.00

const DETOX_PRICES = {
  1: 4000,
  2: 8000,
  3: 11500,
  4: 14500,
  5: 17000,
};

// Agua de Pepino con Limón is Thursday-only. Server enforces this the same
// way the site's front end does, so it can't be ordered by editing requests.
function isPepinoAvailable() {
  const day = new Date().getDay(); // 0 = Sunday ... 4 = Thursday
  return day === 4;
}

// ---------------------------------------------------------------------------
// POST /api/create-checkout-session
//
// Expects a JSON body shaped like:
// {
//   mode: 'pickup' | 'delivery' | 'popup',
//   customer: { firstName, lastName, phone, email, address },
//   cart: {
//     items: { green: 2, mimosa: 1 },              // menu item id -> qty
//     sixPacks: [ { green: 2, mimosa: 4 }, ... ],   // one object per 6-pack, flavor id -> qty (must total 6)
//     detoxes: [1, 2],                              // array of detox lengths in days
//     shotQty: 3                                    // immunity shots
//   }
// }
//
// Returns: { url: 'https://checkout.stripe.com/...' } — redirect the
// customer's browser to that URL to complete payment.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// RATE LIMITING
//
// CORS only blocks browser requests from other websites — it does nothing
// to stop someone hitting this endpoint directly with a script or curl.
// This limits how many checkout sessions any single IP can create in a
// given window, so the API can't be hammered or used to spam your Stripe
// dashboard with junk sessions.
// ---------------------------------------------------------------------------
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 checkout attempts per IP per window — generous for real customers, tight for abuse
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please try again in a few minutes.' },
});

app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { mode, customer, cart } = req.body || {};

    if (!['pickup', 'delivery', 'popup'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid or missing order mode.' });
    }
    if (!customer || !customer.firstName || !customer.lastName) {
      return res.status(400).json({ error: 'First and last name are required.' });
    }
    if (!customer.phone || !customer.email) {
      return res.status(400).json({ error: 'Phone and email are required.' });
    }
    if (mode === 'delivery' && !customer.address) {
      return res.status(400).json({ error: 'Delivery address is required for delivery orders.' });
    }

    const line_items = [];
    const summaryParts = [];
    const structuredItems = [];

    // --- loose menu items -----------------------------------------------
    const items = (cart && cart.items) || {};
    for (const [id, qtyRaw] of Object.entries(items)) {
      const qty = Number(qtyRaw);
      if (!qty || qty <= 0) continue;
      const menuItem = MENU_ITEMS[id];
      if (!menuItem) {
        return res.status(400).json({ error: `Unknown item: ${id}` });
      }
      if (id === 'pepino' && !isPepinoAvailable()) {
        return res.status(400).json({ error: 'Agua de Pepino con Limón is only available to order on Thursdays.' });
      }
      line_items.push({
        quantity: qty,
        price_data: {
          currency: 'usd',
          unit_amount: menuItem.price,
          product_data: { name: menuItem.name },
        },
      });
      summaryParts.push(`${qty}x ${menuItem.name}`);
      structuredItems.push({ name: menuItem.name, qty, price: menuItem.price });
    }

    // --- 6-packs -----------------------------------------------------------
    const sixPacks = (cart && cart.sixPacks) || [];
    sixPacks.forEach((flavorMap, i) => {
      const flavorEntries = Object.entries(flavorMap || {}).filter(([, q]) => Number(q) > 0);
      const total = flavorEntries.reduce((sum, [, q]) => sum + Number(q), 0);
      if (total !== 6) {
        throw new Error(`6-pack #${i + 1} does not total 6 bottles.`);
      }
      const flavorLabel = flavorEntries
        .map(([id, q]) => {
          const menuItem = MENU_ITEMS[id];
          if (!menuItem) throw new Error(`Unknown flavor in 6-pack: ${id}`);
          if (id === 'pepino' && !isPepinoAvailable()) {
            throw new Error('Agua de Pepino con Limón is only available to order on Thursdays.');
          }
          return Number(q) > 1 ? `${q}x ${menuItem.name}` : menuItem.name;
        })
        .join(', ');
      line_items.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: SIXPACK_PRICE,
          product_data: {
            name: `6-Pack #${i + 1}`,
            description: flavorLabel.slice(0, 500),
          },
        },
      });
      summaryParts.push(`6-Pack: ${flavorLabel}`);
      structuredItems.push({ name: `6-Pack (${flavorLabel})`, qty: 1, price: SIXPACK_PRICE });
    });

    // --- detox cleanses ------------------------------------------------
    const detoxes = (cart && cart.detoxes) || [];
    detoxes.forEach((daysRaw) => {
      const days = Number(daysRaw);
      const price = DETOX_PRICES[days];
      if (!price) {
        throw new Error(`Invalid detox length: ${daysRaw}`);
      }
      line_items.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: price,
          product_data: { name: `${days}-Day Detox Cleanse` },
        },
      });
      summaryParts.push(`${days}-Day Detox Cleanse`);
      structuredItems.push({ name: `${days}-Day Detox Cleanse`, qty: 1, price });
    });

    // --- immunity shots (bulk price break at 5+) -------------------------
    const shotQty = Number((cart && cart.shotQty) || 0);
    if (shotQty > 0) {
      const unit = shotQty >= SHOT_BULK_THRESHOLD ? SHOT_PRICE_BULK : SHOT_PRICE_REGULAR;
      line_items.push({
        quantity: shotQty,
        price_data: {
          currency: 'usd',
          unit_amount: unit,
          product_data: { name: 'Immunity Shot (4oz)' },
        },
      });
      summaryParts.push(`${shotQty}x Immunity Shot`);
      structuredItems.push({ name: 'Immunity Shot (4oz)', qty: shotQty, price: unit });
    }

    if (line_items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    // --- delivery fee ----------------------------------------------------
    // Matches the frontend's `mode === 'delivery' && totalCount() > 0`
    // condition — a real cart already exists at this point (checked above),
    // so the fee always applies for delivery orders.
    if (mode === 'delivery') {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: DELIVERY_FEE,
          product_data: { name: 'Delivery Fee' },
        },
      });
      summaryParts.push('Delivery Fee');
      structuredItems.push({ name: 'Delivery Fee', qty: 1, price: DELIVERY_FEE });
    }

    // --- tip ---------------------------------------------------------------
    // Never trust the client-computed tip amount directly for a percentage
    // tip — recompute it here from the real, server-side subtotal (items
    // only, matching the frontend's subtotalPrice(), which is calculated
    // before the delivery fee). A custom/typed-in tip has no "correct"
    // server value to check it against, so that one IS taken from the
    // client, but validated and capped.
    const subtotalCents = line_items
      .filter(li => li.price_data.product_data.name !== 'Delivery Fee')
      .reduce((sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);

    const tipPercentRaw = (cart && cart.tipPercent);
    let tipCents = 0;
    if (tipPercentRaw !== null && tipPercentRaw !== undefined && tipPercentRaw !== '') {
      const pct = Number(tipPercentRaw);
      if (Number.isFinite(pct) && pct > 0) {
        tipCents = Math.round(subtotalCents * (pct / 100));
      }
    } else {
      const customTip = Number((cart && cart.tipAmount) || 0);
      if (Number.isFinite(customTip) && customTip > 0) {
        tipCents = Math.min(Math.round(customTip * 100), MAX_CUSTOM_TIP);
      }
    }

    if (tipCents > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: tipCents,
          product_data: { name: 'Tip' },
        },
      });
      summaryParts.push('Tip');
      structuredItems.push({ name: 'Tip', qty: 1, price: tipCents });
    }

    const modeLabel = { pickup: 'Pickup (Mesa)', delivery: 'Delivery', popup: 'Weekend pop-up (Tolleson)' }[mode];

    // Stripe metadata values are capped at 500 characters each.
    const orderSummary = summaryParts.join(' | ').slice(0, 490);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customer.email,
      success_url: `${SITE_URL}/?order=success`,
      cancel_url: `${SITE_URL}/?order=canceled`,
      metadata: {
        order_mode: modeLabel,
        customer_name: `${customer.firstName} ${customer.lastName}`.slice(0, 500),
        customer_phone: String(customer.phone).slice(0, 500),
        delivery_address: mode === 'delivery' ? String(customer.address || '').slice(0, 500) : '',
        order_summary: orderSummary,
        customer_note: String(customer.note || '').slice(0, 490),
        // JSON-encoded list of individual items, so the dashboard can show
        // them each on their own line instead of one combined summary string.
        structured_items: JSON.stringify(structuredItems).slice(0, 490),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(400).json({ error: err.message || 'Something went wrong creating your checkout session.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Turns a rejected CORS request into a clean 403 response instead of a
// generic "Internal Server Error" page.
app.use((err, _req, res, next) => {
  if (err && err.message && err.message.startsWith('Not allowed by CORS')) {
    return res.status(403).json({ error: 'This origin is not allowed to use this API.' });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`My Mom's Juice checkout backend listening on port ${PORT}`);
});
