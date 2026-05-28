let stripe;
let appConfig;
let checkout;
let actions;
let latestDebugInfo = {};

window.addEventListener("error", (event) => {
  console.error("Window error:", event.error || event.message);
  showMessage(formatError(event.error || event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  showMessage(formatError(event.reason));
});

document.querySelector("#payment-form").addEventListener("submit", handleSubmit);

initialize().catch((error) => {
  console.error("Apple Pay checkout initialization failed:", error);
  showMessage(formatError(error));
  setLoading(false);
});

// Fetches a Checkout Session and captures the client secret.
// This intentionally mirrors Stripe's Custom Checkout Elements example as
// closely as possible, with only the wallet config narrowed to Apple Pay.
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "apple" }),
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
      console.log("Created Apple Pay checkout session:", r.sessionId, r.debug);
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

  checkout.on("change", (session) => {
    document.getElementById("submit").disabled = !session.canConfirm;
    recordDebugInfo({
      checkoutSessionChange: {
        canConfirm: session.canConfirm,
        lastChangeAt: new Date().toISOString(),
      },
    });
  });

  const loadActionsResult = await checkout.loadActions();
  if (loadActionsResult.type === "success") {
    actions = loadActionsResult.actions;
    const session = loadActionsResult.actions.getSession();
    const amount = session?.total?.total?.amount;
    document.querySelector("#button-text").textContent = amount
      ? `Pay ${amount} now`
      : "Subscribe with Apple Pay";
  }

  const contactDetailsElement = checkout.createContactDetailsElement();
  contactDetailsElement.mount("#contact-details-element");

  const paymentElement = checkout.createPaymentElement({
    wallets: {
      applePay: "auto",
      googlePay: "never",
    },
  });
  paymentElement.on("ready", () => {
    recordDebugInfo({
      paymentElement: {
        ready: true,
        walletPage: "apple",
        readyAt: new Date().toISOString(),
      },
    });
  });
  paymentElement.on("loaderror", (event) => {
    console.error("Payment Element load error:", event);
    recordDebugInfo({
      paymentElement: {
        ready: false,
        walletPage: "apple",
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
        applePaySelected: objectContainsString(event, ["apple_pay", "applepay", "apple pay"]),
        selectedPaymentMethodType: event.value?.type,
        selectedPaymentMethodDetails: event.value,
        lastChangeAt: new Date().toISOString(),
      },
    });
  });
  paymentElement.mount("#payment-element");

  const billingAddressElement = checkout.createBillingAddressElement();
  billingAddressElement.mount("#billing-address-element");

  recordDebugInfo({ browserWalletChecks: collectBrowserWalletDebug() });
  setLoading(false);
}

async function handleSubmit(e) {
  e.preventDefault();
  setLoading(true);

  try {
    if (!actions) {
      throw new Error("Checkout is still loading. Please try again in a moment.");
    }

    const { error } = await actions.confirm();

    // This point will only be reached if there is an immediate error when
    // confirming the payment. Otherwise, your customer will be redirected to
    // your `return_url`.
    if (error) {
      showMessage(error.message || formatError(error));
    }
  } catch (error) {
    console.error("Apple Pay confirm threw:", error);
    showMessage(formatError(error));
  }

  setLoading(false);
}

// ------- UI helpers -------

function showMessage(messageText) {
  const messageContainer = document.querySelector("#payment-message");
  messageContainer.classList.remove("hidden");
  messageContainer.textContent = messageText;

  setTimeout(() => {
    messageContainer.classList.add("hidden");
    messageContainer.textContent = "";
  }, 4000);
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
  recordDebugInfo({ httpStatus, ...payload });
}

function recordDebugInfo(info) {
  latestDebugInfo = deepMerge(latestDebugInfo, info);
  const debugContainer = document.querySelector("#debug-info");
  if (!debugContainer) return;

  debugContainer.textContent = JSON.stringify(
    {
      ...latestDebugInfo,
      notes: [
        "Apple Pay page mirrors Stripe's Custom Checkout Elements example: submit handler, setLoading(true), then await actions.confirm().",
        "Payment Element is narrowed to Apple Pay with wallets.applePay='auto' and wallets.googlePay='never'.",
        "This page also mounts Contact Details and Billing Address Elements like Stripe's example.",
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
    hasApplePaySession: typeof window.ApplePaySession !== "undefined",
    canMakeApplePayPayments:
      typeof window.ApplePaySession?.canMakePayments === "function"
        ? window.ApplePaySession.canMakePayments()
        : null,
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
    if (!policy) return "unavailable";
    if (typeof policy.allowsFeature === "function") return policy.allowsFeature("payment");
    if (typeof policy.allowedFeatures === "function") {
      return policy.allowedFeatures().includes("payment");
    }
  } catch (error) {
    return formatError(error);
  }
  return "unavailable";
}

function objectContainsString(value, needles, seen = new WeakSet()) {
  if (value == null) return false;
  if (typeof value === "string") {
    const normalized = value.toLowerCase().replace(/[\s-]/g, "_");
    return needles.some((needle) => normalized.includes(needle.replace(/[\s-]/g, "_")));
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(
    ([key, nestedValue]) =>
      objectContainsString(key, needles, seen) ||
      objectContainsString(nestedValue, needles, seen),
  );
}

function deepMerge(target, source) {
  const output = { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Error)) {
      output[key] = deepMerge(output[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function formatError(error) {
  if (!error) return "An unknown error occurred.";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function setLoading(isLoading) {
  if (isLoading) {
    document.querySelector("#submit").disabled = true;
    document.querySelector("#spinner").classList.remove("hidden");
    document.querySelector("#button-text").classList.add("hidden");
  } else {
    document.querySelector("#submit").disabled = false;
    document.querySelector("#spinner").classList.add("hidden");
    document.querySelector("#button-text").classList.remove("hidden");
  }
}
