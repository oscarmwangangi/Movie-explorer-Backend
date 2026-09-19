// Run this ONCE with: npm run create-paypal-plans
//
// It tells PayPal "here are the two subscription plans I sell"
// (monthly $1 and yearly $10) and prints the Plan IDs you need to
// paste into your .env file as PAYPAL_MONTHLY_PLAN_ID and
// PAYPAL_YEARLY_PLAN_ID.
//
// You only need to run this again if you want to change the price -
// PayPal plans can't be edited, you'd create a new one.

const paypal = require('./paypalClient');

async function main() {
  // Step 1: PayPal needs a "product" before it can have "plans".
  // Think of the product as "Movie Explorer Subscription" and the
  // plans as "the $1/month version" and "the $10/year version".
  const product = await paypal.post('/v1/catalogs/products', {
    name: 'Movie Explorer Subscription',
    description: 'Access to Movie Explorer premium features',
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
  console.log('Created PayPal product:', product.id);

  // Step 2: Create the monthly plan - $1 every month.
  const monthlyPlan = await paypal.post('/v1/billing/plans', {
    product_id: product.id,
    name: 'Monthly Plan',
    description: '$1 per month',
    billing_cycles: [
      {
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0, // 0 = never stops on its own, renews forever
        pricing_scheme: {
          fixed_price: { value: '1.00', currency_code: 'USD' },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 1,
    },
  });
  console.log('Created MONTHLY plan:', monthlyPlan.id);

  // Step 3: Create the yearly plan - $10 every year.
  const yearlyPlan = await paypal.post('/v1/billing/plans', {
    product_id: product.id,
    name: 'Yearly Plan',
    description: '$10 per year',
    billing_cycles: [
      {
        frequency: { interval_unit: 'YEAR', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: { value: '10.00', currency_code: 'USD' },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 1,
    },
  });
  console.log('Created YEARLY plan:', yearlyPlan.id);

  console.log('\n=== Copy these into your .env file ===');
  console.log(`PAYPAL_MONTHLY_PLAN_ID=${monthlyPlan.id}`);
  console.log(`PAYPAL_YEARLY_PLAN_ID=${yearlyPlan.id}`);
}

main().catch((err) => {
  console.error('Failed to create PayPal plans:', err.response?.data || err.message);
  process.exit(1);
});
