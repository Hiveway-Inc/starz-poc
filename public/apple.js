let stripe;
let appConfig;
let checkout;
let actions;
let latestDebugInfo = {};
let isLoading = false;
let checkoutCanConfirm = false;
let syncedApplePayPostalCode = "";
let applePayPostalCodeUpdatePromise = null;
let applePayPostalCodeUpdateTimer;

window.addEventListener("error", (event) => {
  console.error("Window error:", event.error || event.message);
  showMessage(formatError(event.error || event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  showMessage(formatError(event.reason));
});

document.querySelector("#payment-form").addEventListener("submit", handleSubmit);
const applePayPostalCodeInput = document.querySelector("#apple-pay-postal-code");
applePayPostalCodeInput?.addEventListener("input", () => scheduleApplePayPostalCodeSync());
applePayPostalCodeInput?.addEventListener("blur", () => syncApplePayPostalCode());

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
    checkoutCanConfirm = Boolean(session.canConfirm);
    updateSubmitButton();
    recordDebugInfo({
      checkoutSessionChange: {
        canConfirm: session.canConfirm,
        disabledReason: getSubmitDisabledReason(),
        lastChangeAt: new Date().toISOString(),
      },
    });
  });

  const loadActionsResult = await checkout.loadActions();
  if (loadActionsResult.type === "success") {
    actions = loadActionsResult.actions;
    loadActionsResult.actions.getSession();
    document.querySelector("#button-text").textContent = "Pay now";
  }

  const contactDetailsElement = checkout.createContactDetailsElement();
  contactDetailsElement.on("change", (event) => {
    recordDebugInfo({
      contactDetailsElement: {
        complete: event.complete,
        empty: event.empty,
        value: event.value,
        lastChangeAt: new Date().toISOString(),
      },
    });
  });
  contactDetailsElement.mount("#contact-details-element");

  const paymentElement = checkout.createPaymentElement({
    wallets: {
      applePay: "auto",
      googlePay: "never",
    },
    fields: {
      billingDetails: {
        name: "never",
        email: "never",
        phone: "never",
        address: "never",
      },
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

  await syncApplePayPostalCode({ showErrors: false });

  recordDebugInfo({ browserWalletChecks: collectBrowserWalletDebug() });
  setLoading(false);
}

async function handleSubmit(e) {
  e.preventDefault();

  try {
    if (!actions) {
      throw new Error("Checkout is still loading. Please try again in a moment.");
    }

    const postalCode = validateApplePayPostalCode();
    if (!postalCode) {
      return;
    }

    clearTimeout(applePayPostalCodeUpdateTimer);

    if (applePayPostalCodeUpdatePromise) {
      showMessage("Billing ZIP is still updating — click Apple Pay again after this message clears.");
      await applePayPostalCodeUpdatePromise;
      return;
    }

    if (postalCode !== syncedApplePayPostalCode) {
      showMessage("ZIP changed. Updating billing ZIP now — click Apple Pay again after this message clears.");
      await syncApplePayPostalCode();
      return;
    }

    // Apple Pay must be opened directly from the click/tap. Do not await
    // updateBillingAddress immediately before this confirm call.
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
}

function scheduleApplePayPostalCodeSync() {
  clearTimeout(applePayPostalCodeUpdateTimer);
  applePayPostalCodeUpdateTimer = setTimeout(() => {
    syncApplePayPostalCode({ showErrors: false });
  }, 400);
}

async function syncApplePayPostalCode({ showErrors = true } = {}) {
  if (!actions) return;

  const postalCode = showErrors
    ? validateApplePayPostalCode()
    : document.querySelector("#apple-pay-postal-code")?.value.trim();

  if (!postalCode) return;
  if (postalCode === syncedApplePayPostalCode) return;

  applePayPostalCodeUpdatePromise = actions.updateBillingAddress({
    address: {
      postal_code: postalCode,
      country: "US",
    },
  });

  try {
    await applePayPostalCodeUpdatePromise;
    syncedApplePayPostalCode = postalCode;
    recordDebugInfo({
      applePayCustomPostalCode: {
        provided: true,
        syncedPostalCode: postalCode,
        syncedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Apple Pay ZIP update failed:", error);
    if (showErrors) showMessage(formatError(error));
    recordDebugInfo({ applePayPostalCodeUpdateError: error });
  } finally {
    applePayPostalCodeUpdatePromise = null;
  }
}

function validateApplePayPostalCode() {
  const input = document.querySelector("#apple-pay-postal-code");
  const error = document.querySelector("#apple-pay-postal-code-errors");
  const postalCode = input?.value.trim() ?? "";

  if (!postalCode) {
    input?.classList.add("error");
    if (error) error.textContent = "Enter a ZIP/postal code for Apple Pay.";
    showMessage("Enter a ZIP/postal code for Apple Pay.");
    return "";
  }

  input.classList.remove("error");
  if (error) error.textContent = "";

  recordDebugInfo({
    applePayCustomPostalCode: {
      provided: true,
      updatedAt: new Date().toISOString(),
    },
  });

  return postalCode;
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
        "Apple Pay page uses a manual ZIP field instead of Stripe's Billing Address Element.",
        "The page syncs the manual ZIP with actions.updateBillingAddress() before the Apple Pay click; the submit handler does not await billing updates immediately before actions.confirm().",
        "Payment Element is narrowed to Apple Pay with wallets.applePay='auto' and wallets.googlePay='never', and fields.billingDetails.address='never'.",
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

function setLoading(loading) {
  isLoading = loading;
  updateSubmitButton();

  if (isLoading) {
    document.querySelector("#spinner").classList.remove("hidden");
    document.querySelector("#button-text").classList.add("hidden");
  } else {
    document.querySelector("#spinner").classList.add("hidden");
    document.querySelector("#button-text").classList.remove("hidden");
  }

  recordDebugInfo({
    submitButton: {
      disabled: document.querySelector("#submit").disabled,
      disabledReason: getSubmitDisabledReason(),
      isLoading,
      checkoutCanConfirm,
      updatedAt: new Date().toISOString(),
    },
  });
}

function updateSubmitButton() {
  // Keep the button enabled while testing so failed confirms surface Stripe errors.
  document.querySelector("#submit").disabled = false;
}

function getSubmitDisabledReason() {
  if (isLoading) return "loading, but button intentionally left enabled";
  if (!checkoutCanConfirm) return "checkout.canConfirm is false, but button intentionally left enabled";
  return "";
}
