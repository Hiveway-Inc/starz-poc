let stripe;
let appConfig;
let checkout;
let actions;
let paymentElementMounted = false;
// Create the Checkout Session after the customer enters their ZIP code so we
// can attach it to the Stripe Customer/Subscription metadata.

window.addEventListener("error", (event) => {
  console.error("Window error:", event.error || event.message);
  showMessage(formatError(event.error || event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  showMessage(formatError(event.reason));
});

document
  .querySelector("#payment-form")
  .addEventListener("submit", handleSubmit);

// Fetches a Checkout Session and captures the client secret
async function initialize() {
  const postalCode = document.querySelector("#postal-code").value.trim();

  if (!appConfig) {
    appConfig = await fetchJson("/config");
  }

  if (!stripe) {
    stripe = Stripe(appConfig.publishableKey);
  }

  const promise = fetch("/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postalCode }),
  })
    .then(async (response) => {
      const payload = await parseJsonResponse(response);
      updateDebugInfo(payload, response.status);

      if (!response.ok || payload.error) {
        throw new Error(payload.error?.message || "Failed to create checkout session.");
      }

      return payload;
    })
    .then((r) => {
      console.log("Created checkout session:", r.sessionId, r.debug);
      document.querySelector("#checkout-session-id").textContent =
        r.sessionId || "Unavailable";
      return r.clientSecret;
    });

  const appearance = {
    theme: "stripe",
  };
  checkout = stripe.initCheckout({
    clientSecret: promise,
    elementsOptions: { appearance },
  });

  const loadActionsResult = await checkout.loadActions();
  if (loadActionsResult.type === "success") {
    actions = loadActionsResult.actions;
    loadActionsResult.actions.getSession();
    document.querySelector("#button-text").textContent = "Subscribe now";
  }

  if (!paymentElementMounted) {
    const paymentElement = checkout.createPaymentElement({
      fields: {
        billingDetails: {
          // We provide these manually with actions.updateBillingAddress().
          // Tell Payment Element not to collect them too.
          name: "never",
          address: "never",
        },
      },
    });
    paymentElement.mount("#payment-element");
    paymentElementMounted = true;
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  setLoading(true);
  clearMessage();

  const postalCodeInput = document.querySelector("#postal-code");
  const postalCodeError = document.querySelector("#postal-code-errors");
  if (!postalCodeInput.value.trim()) {
    postalCodeInput.classList.add("error");
    postalCodeError.textContent = "Enter a ZIP/postal code.";
    setLoading(false);
    return;
  }
  postalCodeInput.classList.remove("error");
  postalCodeError.textContent = "";

  try {
    if (!actions) {
      await initialize();
      showMessage("Payment form loaded. Complete the payment details, then submit again.");
      return;
    }

    // Custom Checkout does not automatically know about our separate ZIP field.
    // Because the server creates the Session with billing_address_collection:
    // "required", Stripe requires the client to provide a billing address before
    // confirm. For this POC, use a complete US test address and the entered ZIP.
    const testAddress = {
      line1: appConfig.testAddress.line1,
      city: appConfig.testAddress.city,
      state: appConfig.testAddress.state,
      postal_code: postalCodeInput.value.trim(),
      country: appConfig.testAddress.country,
    };

    await actions.updateBillingAddress({
      name: "Test Customer",
      address: testAddress,
    });

    await actions.updateShippingAddress({
      name: "Test Customer",
      address: testAddress,
    });

    const result = await actions.confirm();

    // This point will only be reached if there is an immediate error when
    // confirming the payment. Otherwise, your customer will be redirected to
    // your `return_url`. For some payment methods like iDEAL, your customer will
    // be redirected to an intermediate site first to authorize the payment, then
    // redirected to the `return_url`.
    if (result?.error) {
      console.error("Checkout confirm error:", result.error);
      showMessage(formatError(result.error));
    }
  } catch (error) {
    console.error("Checkout confirm threw:", error);
    showMessage(formatError(error));
  } finally {
    setLoading(false);
  }
}

// ------- UI helpers -------

function showMessage(messageText) {
  const messageContainer = document.querySelector("#payment-message");

  messageContainer.classList.remove("hidden");
  messageContainer.textContent = messageText;
}

function clearMessage() {
  const messageContainer = document.querySelector("#payment-message");

  messageContainer.classList.add("hidden");
  messageContainer.textContent = "";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return parseJsonResponse(response);
}

async function parseJsonResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    throw new Error(
      `Expected JSON from ${response.url}, but got ${contentType || "unknown content type"} ` +
        `with HTTP ${response.status}. Response starts with: ${text.slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON from ${response.url} with HTTP ${response.status}: ${error.message}. ` +
        `Response starts with: ${text.slice(0, 120)}`,
    );
  }
}

function updateDebugInfo(payload, httpStatus) {
  const debugContainer = document.querySelector("#debug-info");
  if (!debugContainer) {
    return;
  }

  debugContainer.textContent = JSON.stringify(
    {
      httpStatus,
      ...payload,
      notes: [
        "payment_method_types is hard-coded server-side to ['card', 'klarna'].",
        "If Klarna is in requested/session payment method types but not visible, Stripe may have filtered it for eligibility, country, currency, amount, customer details, Dashboard settings, or subscription/Billing constraints.",
        "If session creation fails, check error.message/code/param above.",
      ],
    },
    null,
    2,
  );
}

function formatError(error) {
  if (!error) {
    return "An unknown error occurred.";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

// Show a spinner on payment submission
function setLoading(isLoading) {
  if (isLoading) {
    // Disable the button and show a spinner
    document.querySelector("#submit").disabled = true;
    document.querySelector("#spinner").classList.remove("hidden");
    document.querySelector("#button-text").classList.add("hidden");
  } else {
    document.querySelector("#submit").disabled = false;
    document.querySelector("#spinner").classList.add("hidden");
    document.querySelector("#button-text").classList.remove("hidden");
  }
}
