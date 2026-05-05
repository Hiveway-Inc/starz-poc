require("dotenv").config();

const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 4141;

const YOUR_DOMAIN = process.env.YOUR_DOMAIN;

// Klarna is supported for eligible Stripe Billing subscription flows.
// Use a recurring Price ID here.
const CHECKOUT_MODE = "subscription";
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const CUSTOMER_ID = process.env.STRIPE_CUSTOMER_ID;
const TEST_ADDRESS = {
  line1: process.env.TEST_ADDRESS_LINE1,
  city: process.env.TEST_ADDRESS_CITY,
  state: process.env.TEST_ADDRESS_STATE,
  country: process.env.TEST_ADDRESS_COUNTRY,
};

const requiredEnvVars = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_CUSTOMER_ID",
  "YOUR_DOMAIN",
  "TEST_ADDRESS_LINE1",
  "TEST_ADDRESS_CITY",
  "TEST_ADDRESS_STATE",
  "TEST_ADDRESS_COUNTRY",
];

const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvVars.join(", ")}`);
}

app.get("/config", (req, res) => {
  res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    testAddress: TEST_ADDRESS,
  });
});

app.post("/create-checkout-session", async (req, res) => {
  console.log(
    `[${new Date().toISOString()}] POST /create-checkout-session hit`,
  );

  const { postalCode } = req.body ?? {};
  const customerId = CUSTOMER_ID;

  let session;

  try {
    if (postalCode) {
      // Automatic tax needs a recognizable customer tax location. A ZIP/postal
      // code alone can be ambiguous, so include a complete test billing address.
      await stripe.customers.update(customerId, {
        address: {
          line1: TEST_ADDRESS.line1,
          city: TEST_ADDRESS.city,
          state: TEST_ADDRESS.state,
          postal_code: postalCode,
          country: TEST_ADDRESS.country,
        },
      });
    }
    session = await stripe.checkout.sessions.create({
      ui_mode: "custom",
      customer: customerId,
      shipping_address_collection: {
        allowed_countries: ["US", "CA"],
      },
      billing_address_collection: "required",
      customer_update: {
        address: "auto",
        shipping: "auto",
      },
      line_items: [
        {
          // Provide the exact recurring Price ID (for example, price_1234) of the product you want to sell.
          price: PRICE_ID,
          quantity: 1,
        },
      ],
      mode: CHECKOUT_MODE,
      // Hard-coded requested payment methods for this POC.
      payment_method_types: ["card", "klarna"],
      return_url: `${YOUR_DOMAIN}/complete.html?session_id={CHECKOUT_SESSION_ID}`,
      automatic_tax: { enabled: true },
      metadata: {
        postal_code: postalCode ?? "",
      },
      subscription_data: {
        metadata: {
          postal_code: postalCode ?? "",
        },
      },
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to create checkout session`, {
      type: error.type,
      code: error.code,
      decline_code: error.decline_code,
      message: error.message,
      param: error.param,
      requestId: error.requestId,
    });

    res.status(error.statusCode || 500).send({
      error: {
        type: error.type,
        code: error.code,
        decline_code: error.decline_code,
        message: error.message,
        param: error.param,
        requestId: error.requestId,
      },
      debug: {
        requestedPaymentMethodTypes: ["card", "klarna"],
        mode: CHECKOUT_MODE,
        priceId: PRICE_ID,
        customerId,
        postalCodeProvided: Boolean(postalCode),
        allowedShippingCountries: ["US", "CA"],
        billingAddressCollection: "required",
        automaticTaxEnabled: true,
      },
    });
    return;
  }

  console.log(`[${new Date().toISOString()}] Created checkout session`, {
    sessionId: session.id,
    mode: session.mode,
    status: session.status,
  });

  res.send({
    clientSecret: session.client_secret,
    sessionId: session.id,
    debug: {
      requestedPaymentMethodTypes: ["card", "klarna"],
      sessionPaymentMethodTypes: session.payment_method_types,
      mode: session.mode,
      currency: session.currency,
      amountSubtotal: session.amount_subtotal,
      amountTotal: session.amount_total,
      customerId: session.customer,
      priceId: PRICE_ID,
      postalCodeProvided: Boolean(postalCode),
      allowedShippingCountries: ["US", "CA"],
      billingAddressCollection: "required",
      automaticTaxEnabled: true,
    },
  });
});

app.get("/session-status", async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /session-status hit`, {
    session_id: req.query.session_id,
  });

  const session = await stripe.checkout.sessions.retrieve(
    req.query.session_id,
    {
      expand: [
        "subscription",
        "subscription.latest_invoice.payment_intent",
        "subscription.latest_invoice.payment_intent.payment_method",
      ],
    },
  );

  const subscription = session.subscription;
  const paymentIntent = subscription?.latest_invoice?.payment_intent;
  const paymentMethod = paymentIntent?.payment_method;

  console.log(`[${new Date().toISOString()}] Retrieved session status`, {
    sessionId: session.id,
    sessionStatus: session.status,
    paymentStatus: session.payment_status,
    subscriptionId: subscription?.id ?? null,
    subscriptionStatus: subscription?.status ?? null,
    paymentIntentId: paymentIntent?.id ?? null,
    paymentIntentStatus: paymentIntent?.status ?? null,
    paymentMethodType: paymentMethod?.type ?? null,
  });

  res.send({
    status: session.status,
    payment_status: session.payment_status,
    subscription_id: subscription?.id ?? null,
    subscription_status: subscription?.status ?? null,
    payment_intent_id: paymentIntent?.id ?? null,
    payment_intent_status: paymentIntent?.status ?? null,
    payment_method_type: paymentMethod?.type ?? null,
  });
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
