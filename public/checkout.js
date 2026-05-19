let stripe;
let appConfig;
let checkout;
let actions;
let paymentElementMounted = false;
let latestDebugInfo = {};

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

initialize().catch((error) => {
  console.error("Checkout initialization failed:", error);
  showMessage(formatError(error));
  setLoading(false);
});

// Fetches a Checkout Session immediately so the Payment Element renders on load.
async function initialize() {
  setLoading(true);
  clearMessage();

  if (!appConfig) {
    appConfig = await fetchJson("/config");
  }

  if (!stripe) {
    stripe = Stripe(appConfig.publishableKey);
  }

  const clientSecret = fetch("/create-checkout-session", {
    method: "POST",
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

  checkout = stripe.initCheckoutElementsSdk({
    clientSecret,
    elementsOptions: { appearance },
  });

  const loadActionsResult = await checkout.loadActions();
  if (loadActionsResult.type === "success") {
    actions = loadActionsResult.actions;
    loadActionsResult.actions.getSession();
    document.querySelector("#button-text").textContent = "Subscribe now";
  }

  if (!paymentElementMounted) {
    // Let Stripe collect required billing details (including ZIP/postal code)
    // inside the Payment Element instead of using our own ZIP field.
    const paymentElement = checkout.createPaymentElement({
      // Keep wallets enabled inside the Payment Element. This does not add the
      // Express Checkout Element; it only tells Stripe not to suppress wallet
      // rows/buttons that are eligible for this Payment Element instance.
      wallets: {
        googlePay: "auto",
        applePay: "auto",
      },
    });

    paymentElement.on("ready", () => {
      recordDebugInfo({
        paymentElement: {
          ready: true,
          readyAt: new Date().toISOString(),
        },
      });
    });

    paymentElement.on("loaderror", (event) => {
      console.error("Payment Element load error:", event);
      recordDebugInfo({
        paymentElement: {
          ready: false,
          loadError: event?.error || event,
          loadErrorAt: new Date().toISOString(),
        },
      });
    });

    paymentElement.on("change", (event) => {
      recordDebugInfo({
        paymentElement: {
          complete: event.complete,
          empty: event.empty,
          collapsed: event.collapsed,
          selectedPaymentMethodType: event.value?.type,
          lastChangeAt: new Date().toISOString(),
        },
      });
    });

    paymentElement.mount("#payment-element");
    paymentElementMounted = true;

    recordDebugInfo({
      browserWalletChecks: collectBrowserWalletDebug(),
    });
  }

  setLoading(false);
}

async function handleSubmit(e) {
  e.preventDefault();
  setLoading(true);
  clearMessage();

  try {
    if (!actions) {
      throw new Error("Checkout is still loading. Please try again in a moment.");
    }

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
  recordDebugInfo({
    httpStatus,
    ...payload,
  });
}

function recordDebugInfo(info) {
  latestDebugInfo = deepMerge(latestDebugInfo, info);

  const debugContainer = document.querySelector("#debug-info");
  if (!debugContainer) {
    return;
  }

  debugContainer.textContent = JSON.stringify(
    {
      ...latestDebugInfo,
      notes: [
        "payment_method_types is hard-coded server-side to ['card', 'klarna'].",
        "Google Pay is a card wallet; the server must allow card, and the browser/session must be wallet-eligible.",
        "The Payment Element is explicitly created with wallets.googlePay = 'auto'; no Express Checkout Element is used.",
        "Stripe does not expose a full per-wallet rejection reason from the Payment Element. Use browserWalletChecks plus Payment Element loaderror/ready to narrow down client-side issues.",
        "Common Google Pay blockers: non-HTTPS origin, unsupported browser, no Google Pay/Chrome payment method, ineligible country/currency/amount, browser payment permissions/policies, or Stripe account/payment-method settings.",
        "Billing address collection is required server-side, so Stripe collects ZIP/postal code in the Payment Element.",
        "If Klarna is in requested/session payment method types but not visible, Stripe may have filtered it for eligibility, country, currency, amount, customer details, Dashboard settings, or subscription/Billing constraints.",
        "If session creation fails, check error.message/code/param above.",
      ],
    },
    null,
    2,
  );
}

function collectBrowserWalletDebug() {
  return {
    href: window.location.href,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    isSecureContext: window.isSecureContext,
    hasPaymentRequest: typeof window.PaymentRequest !== "undefined",
    userAgent: window.navigator.userAgent,
    userAgentData: window.navigator.userAgentData
      ? {
          brands: window.navigator.userAgentData.brands,
          mobile: window.navigator.userAgentData.mobile,
          platform: window.navigator.userAgentData.platform,
        }
      : null,
    permissionsPolicyPayment: getPaymentPermissionsPolicyDebug(),
  };
}

function getPaymentPermissionsPolicyDebug() {
  try {
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (!policy) {
      return "unavailable";
    }

    if (typeof policy.allowsFeature === "function") {
      return policy.allowsFeature("payment");
    }

    if (typeof policy.allowedFeatures === "function") {
      return policy.allowedFeatures().includes("payment");
    }
  } catch (error) {
    return formatError(error);
  }

  return "unavailable";
}

function deepMerge(target, source) {
  const output = { ...target };

  for (const [key, value] of Object.entries(source || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Error)
    ) {
      output[key] = deepMerge(output[key] || {}, value);
    } else {
      output[key] = value;
    }
  }

  return output;
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
