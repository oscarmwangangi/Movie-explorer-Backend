// The numbers behind the admin "Sales" dashboard and the Payments page.
//
//   GET /api/admin/payments/summary?days=30   revenue, payment counts, success rate, daily chart
//   GET /api/admin/payments?status=&search=&page=&pageSize=   the payment list
//
// Admin only: requireLogin + requireAdmin run before every route below.
//
// Two rules to remember when reading the numbers:
//   1. REVENUE only counts orders with status COMPLETED (Safaricom confirmed the money).
//      Users an admin registers, extends or reactivates by hand have no order,
//      so they are NOT counted as revenue.
//   2. "Today", "this month" and the daily chart use Nairobi time (Africa/Nairobi),
//      so a payment at 11:30pm Nairobi time lands on the right day.

const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { getShortReason } = require('../services/paymentHelpers');

const router = express.Router();
router.use(requireLogin, requireAdmin);

const TZ = 'Africa/Nairobi';
const ALLOWED_DAY_RANGES = [7, 30, 90];

// A PENDING order older than this is treated as "ABANDONED": the customer
// never answered the prompt and no result ever came back.
const ABANDONED_AFTER_MINUTES = 10;

// SQL snippet: the status we SHOW (PENDING + old = ABANDONED). Not stored in the database.
const DISPLAY_STATUS_SQL = `
  CASE
    WHEN o.status = 'PENDING' AND o.created_at < NOW() - INTERVAL '${ABANDONED_AFTER_MINUTES} minutes'
    THEN 'ABANDONED'
    ELSE o.status
  END`;

// SQL snippet: "midnight today in Nairobi", and the start of the last-N-days window.
const TODAY_SQL = `date_trunc('day', NOW() AT TIME ZONE '${TZ}')`;
const DAY_OF_ORDER_SQL = `date_trunc('day', o.created_at AT TIME ZONE '${TZ}')`;

// ---------------------------------------------------------------
// GET /api/admin/payments/summary?days=7|30|90
// ---------------------------------------------------------------
router.get('/summary', async (req, res) => {
  const requestedDays = Number(req.query.days);
  const days = ALLOWED_DAY_RANGES.includes(requestedDays) ? requestedDays : 30;

  try {
    // 1. Revenue + number of paid orders for fixed periods, and for the chosen window.
    const periods = await pool.query(
      `WITH t AS (SELECT ${TODAY_SQL} AS today),
            o AS (
              SELECT o.status, o.amount, ${DAY_OF_ORDER_SQL} AS day
              FROM orders o
            )
       SELECT
         COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'COMPLETED'), 0)::int AS revenue_all,
         COUNT(*) FILTER (WHERE o.status = 'COMPLETED')::int AS payments_all,

         COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'COMPLETED' AND o.day = t.today), 0)::int AS revenue_today,
         COUNT(*) FILTER (WHERE o.status = 'COMPLETED' AND o.day = t.today)::int AS payments_today,

         COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'COMPLETED' AND o.day > t.today - INTERVAL '7 days'), 0)::int AS revenue_7d,
         COUNT(*) FILTER (WHERE o.status = 'COMPLETED' AND o.day > t.today - INTERVAL '7 days')::int AS payments_7d,

         COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'COMPLETED' AND o.day >= date_trunc('month', t.today)), 0)::int AS revenue_month,
         COUNT(*) FILTER (WHERE o.status = 'COMPLETED' AND o.day >= date_trunc('month', t.today))::int AS payments_month,

         COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'COMPLETED' AND o.day > t.today - ($1::int * INTERVAL '1 day')), 0)::int AS revenue_window,
         COUNT(*) FILTER (WHERE o.status = 'COMPLETED' AND o.day > t.today - ($1::int * INTERVAL '1 day'))::int AS payments_window,

         COALESCE(SUM(o.amount) FILTER (
           WHERE o.status = 'COMPLETED'
             AND o.day <= t.today - ($1::int * INTERVAL '1 day')
             AND o.day > t.today - (2 * $1::int * INTERVAL '1 day')
         ), 0)::int AS revenue_previous_window
       FROM o CROSS JOIN t`,
      [days]
    );
    const p = periods.rows[0];

    // 2. How many payment attempts ended each way, inside the chosen window.
    const attemptRows = await pool.query(
      `SELECT ${DISPLAY_STATUS_SQL} AS status, COUNT(*)::int AS count
       FROM orders o
       WHERE ${DAY_OF_ORDER_SQL} > ${TODAY_SQL} - ($1::int * INTERVAL '1 day')
       GROUP BY 1`,
      [days]
    );
    const attempts = { completed: 0, failed: 0, cancelled: 0, pending: 0, abandoned: 0 };
    attemptRows.rows.forEach((row) => {
      attempts[row.status.toLowerCase()] = row.count;
    });
    const total =
      attempts.completed + attempts.failed + attempts.cancelled + attempts.pending + attempts.abandoned;

    // Success rate only looks at attempts that have finished (so a payment that
    // is still waiting for the PIN doesn't make the rate look worse).
    const finished = attempts.completed + attempts.failed + attempts.cancelled + attempts.abandoned;
    const successRate = finished > 0 ? Math.round((attempts.completed / finished) * 1000) / 10 : null;

    // 3. Which plan brings in the money, inside the chosen window.
    const byPlanRows = await pool.query(
      `SELECT o.plan_type, COALESCE(SUM(o.amount), 0)::int AS revenue, COUNT(*)::int AS payments
       FROM orders o
       WHERE o.status = 'COMPLETED'
         AND ${DAY_OF_ORDER_SQL} > ${TODAY_SQL} - ($1::int * INTERVAL '1 day')
       GROUP BY o.plan_type
       ORDER BY revenue DESC`,
      [days]
    );

    // 4. Why payments did not go through (insufficient balance, cancelled, wrong PIN...).
    const reasonRows = await pool.query(
      `SELECT o.result_code, COUNT(*)::int AS count
       FROM orders o
       WHERE o.status IN ('FAILED', 'CANCELLED')
         AND ${DAY_OF_ORDER_SQL} > ${TODAY_SQL} - ($1::int * INTERVAL '1 day')
       GROUP BY o.result_code
       ORDER BY count DESC`,
      [days]
    );
    // Different result codes can share a label (e.g. every unknown code is "Other failure"),
    // so we add them up by label.
    const reasonTotals = {};
    reasonRows.rows.forEach((row) => {
      const label = getShortReason(row.result_code);
      reasonTotals[label] = (reasonTotals[label] || 0) + row.count;
    });
    const failureReasons = Object.entries(reasonTotals)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // 5. One row per day for the chart. generate_series makes a row for EVERY day,
    //    so days with no sales show as 0 instead of being skipped.
    const dailyRows = await pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COALESCE(SUM(o.amount), 0)::int AS revenue,
              COUNT(o.id)::int AS payments
       FROM generate_series(
              ${TODAY_SQL} - (($1::int - 1) * INTERVAL '1 day'),
              ${TODAY_SQL},
              INTERVAL '1 day'
            ) AS d(day)
       LEFT JOIN orders o
         ON o.status = 'COMPLETED'
        AND ${DAY_OF_ORDER_SQL} = d.day
       GROUP BY d.day
       ORDER BY d.day`,
      [days]
    );

    // Growth compared with the window right before this one (null if there was nothing to compare with).
    const growthPercent =
      p.revenue_previous_window > 0
        ? Math.round(((p.revenue_window - p.revenue_previous_window) / p.revenue_previous_window) * 1000) / 10
        : null;

    res.json({
      currency: 'KES',
      days,
      revenue: {
        allTime: p.revenue_all,
        today: p.revenue_today,
        last7Days: p.revenue_7d,
        thisMonth: p.revenue_month,
        window: p.revenue_window,
        previousWindow: p.revenue_previous_window,
        growthPercent,
      },
      payments: {
        allTime: p.payments_all,
        today: p.payments_today,
        last7Days: p.payments_7d,
        thisMonth: p.payments_month,
        window: p.payments_window,
      },
      averagePayment: p.payments_window > 0 ? Math.round(p.revenue_window / p.payments_window) : 0,
      attempts: { ...attempts, total, successRate },
      byPlan: byPlanRows.rows.map((r) => ({ planType: r.plan_type, revenue: r.revenue, payments: r.payments })),
      failureReasons,
      daily: dailyRows.rows,
    });
  } catch (err) {
    console.error('Failed to build payments summary:', err);
    res.status(500).json({ error: 'Failed to load sales numbers.' });
  }
});

// ---------------------------------------------------------------
// GET /api/admin/payments?status=COMPLETED&search=jane&page=1&pageSize=20
//   status:   COMPLETED | FAILED | CANCELLED | PENDING | ABANDONED (leave empty for all)
//   search:   part of an email, phone number or M-Pesa receipt number
// ---------------------------------------------------------------
router.get('/', async (req, res) => {
  const status = String(req.query.status || '').toUpperCase();
  const validStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'PENDING', 'ABANDONED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${validStatuses.join(', ')}.` });
  }

  // Page numbers: keep them sensible so nobody can ask for a million rows.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

  // In LIKE searches, % and _ are wildcards. Put a backslash before them so they match literally.
  const search = String(req.query.search || '').trim();
  const searchPattern = search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : '';

  // The same filter is used for the rows AND for the total count.
  const baseQuery = `
    FROM (
      SELECT o.id, o.created_at, o.plan_type, o.amount, o.phone_number,
             o.mpesa_receipt_number, o.result_code, o.checkout_request_id,
             ${DISPLAY_STATUS_SQL} AS display_status,
             u.email, u.name
      FROM orders o
      JOIN users u ON u.id = o.user_id
    ) p
    WHERE ($1::text = '' OR p.display_status = $1)
      AND ($2::text = '' OR p.email ILIKE $2 OR p.phone_number ILIKE $2 OR p.mpesa_receipt_number ILIKE $2)`;

  try {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${baseQuery}`, [status, searchPattern]);

    const rowsResult = await pool.query(
      `SELECT p.* ${baseQuery}
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [status, searchPattern, pageSize, (page - 1) * pageSize]
    );

    const payments = rowsResult.rows.map((row) => {
      let reason = null;
      if (row.display_status === 'FAILED' || row.display_status === 'CANCELLED') {
        reason = getShortReason(row.result_code);
      } else if (row.display_status === 'ABANDONED') {
        reason = 'No response from customer';
      }

      return {
        id: row.id,
        createdAt: row.created_at,
        status: row.display_status,
        reason,
        planType: row.plan_type,
        amount: row.amount,
        phoneNumber: row.phone_number,
        receipt: row.mpesa_receipt_number,
        userEmail: row.email,
        userName: row.name,
      };
    });

    res.json({ payments, total: countResult.rows[0].total, page, pageSize });
  } catch (err) {
    console.error('Failed to load payments list:', err);
    res.status(500).json({ error: 'Failed to load payments.' });
  }
});

module.exports = router;
