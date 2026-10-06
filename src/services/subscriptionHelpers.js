// Shared subscription helpers, used by the payment code and by the
// admin routes.

// Works out when a subscription should expire.
//   planType: 'monthly' or 'yearly'
//   from:     the date to count from (defaults to right now).
//             When a customer renews BEFORE their old plan ends, we pass
//             their old expiry date here so they don't lose the days they
//             already paid for.
function calculateExpiryDate(planType, from = new Date()) {
  const date = new Date(from); // copy it, so we never change the original
  if (planType === 'yearly') {
    date.setFullYear(date.getFullYear() + 1);
  } else {
    date.setMonth(date.getMonth() + 1);
  }
  return date;
}

module.exports = { calculateExpiryDate };
