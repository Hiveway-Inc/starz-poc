# Stripe Klarna Subscription POC

This sample uses Stripe Custom Checkout / Payment Element with the Checkout Sessions API to create a **subscription** Checkout Session that explicitly requests:

```js
payment_method_types: ["card", "klarna"]
```

It also includes a small debug panel on the checkout page to help diagnose why Klarna may or may not appear.

## Prerequisites

- Node.js installed
- Stripe test account
- Klarna enabled in your Stripe Dashboard/payment method settings
- A recurring Stripe Price ID for the subscription
- A test Customer ID
- A public URL for redirects, such as an ngrok URL

## Environment setup

Copy the example env file:

```sh
cp .env.example .env
```

Then edit `.env` with your real test values:

```env
PORT=4141
YOUR_DOMAIN=https://your-ngrok-or-domain.example

STRIPE_SECRET_KEY=sk_test_replace_me
STRIPE_PUBLISHABLE_KEY=pk_test_replace_me
STRIPE_PRICE_ID=price_replace_me
STRIPE_CUSTOMER_ID=cus_replace_me

TEST_ADDRESS_LINE1=345 N Canon Dr
TEST_ADDRESS_CITY=Beverly Hills
TEST_ADDRESS_STATE=CA
TEST_ADDRESS_COUNTRY=US
```

Notes:

- `.env` is intentionally gitignored.
- `.env.example` is safe to commit and should contain placeholders only.
- `STRIPE_PRICE_ID` should be a **recurring** Price because this sample uses `mode: "subscription"`.
- `YOUR_DOMAIN` must match the externally accessible domain used for the return URL, for example your current ngrok domain.

## Install dependencies

```sh
npm install
```

## Run the server

```sh
npm start
```

By default the app runs on:

```txt
http://localhost:4141
```

Open:

```txt
http://localhost:4141/checkout.html
```

## HTTPS testing with ngrok

Apple Pay and Google Pay require HTTPS for realistic browser testing. You can expose the local server over HTTPS with ngrok:

```sh
ngrok http 4141
```

Then set `YOUR_DOMAIN` in `.env` to the HTTPS forwarding URL shown by ngrok, for example:

```env
YOUR_DOMAIN=https://your-ngrok-subdomain.ngrok-free.app
```

Restart the server after updating `.env`, then open:

```txt
https://your-ngrok-subdomain.ngrok-free.app/checkout.html
```

Use the same HTTPS ngrok domain as the Checkout Session `return_url` domain so redirects return to the test app correctly.

## Test ZIP/postal code

The checkout page pre-populates the ZIP code with:

```txt
90210
```

For this POC, the client code uses that ZIP along with this configured test address for billing and shipping:

```txt
345 N Canon Dr
Beverly Hills, CA 90210
US
```

This is needed because:

- `automatic_tax` is enabled.
- `billing_address_collection` is required.
- `shipping_address_collection` is enabled.
- Custom Checkout requires billing/shipping address data to be provided manually unless you use an Address Element.

## Debugging Klarna visibility

The checkout page displays a `Debug` panel after creating a Checkout Session.

The debug payload includes:

- HTTP status
- Checkout Session ID
- requested payment method types
- Stripe-returned session payment method types
- mode
- currency
- subtotal/total
- customer ID
- Price ID
- whether a postal code was provided
- billing/shipping/tax configuration
- Stripe error details, if session creation fails

If Klarna is requested but does not appear, common reasons include:

- Klarna is not enabled in the Stripe Dashboard.
- The customer country, currency, amount, or subscription configuration is not eligible.
- Required customer/billing/shipping details are missing.
- The Price is not a supported recurring Price.
- The Stripe account is not eligible for Klarna subscriptions.
- Shipping countries are currently limited in code to `US` and `CA`.

## Current implementation details

The server creates Checkout Sessions with:

```js
ui_mode: "custom",
mode: "subscription",
payment_method_types: ["card", "klarna"],
automatic_tax: { enabled: true },
billing_address_collection: "required",
shipping_address_collection: {
  allowed_countries: ["US", "CA"],
}
```

The frontend manually calls these Custom Checkout actions before confirmation:

```js
actions.updateBillingAddress(...)
actions.updateShippingAddress(...)
actions.confirm()
```

The Payment Element is configured not to double-collect billing name/address because those values are supplied manually.
