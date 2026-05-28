let stripe;
let appConfig;
let checkout;
let actions;
let paymentElement;
let paymentElementMounted = false;
let paymentElementBillingFieldsNever = false;
let googlePaySelected = true;
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
  console.error("Google Pay checkout initialization failed:", error);
  showMessage(formatError(error));
  setLoading(false);
});

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
    body: JSON.stringify({ source: "google" }),
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
      console.log("Created Google Pay checkout session:", r.sessionId, r.debug);
      document.querySelector("#checkout-session-id").textContent =
        r.sessionId || "Unavailable";
      return r.clientSecret;
    });

  checkout = stripe.initCheckoutElementsSdk({
    clientSecret,
    elementsOptions: { appearance: { theme: "stripe" } },
  });

  const loadActionsResult = await checkout.loadActions();
  if (loadActionsResult.type === "success") {
    actions = loadActionsResult.actions;
    loadActionsResult.actions.getSession();
    document.querySelector("#button-text").textContent = "Subscribe";
  }

  if (!paymentElementMounted) {
    mountPaymentElement({ billingFieldsNever: true });
    updateGooglePayPostalCodeVisibility();
    recordDebugInfo({ browserWalletChecks: collectBrowserWalletDebug() });
  }

  setLoading(false);
}

function mountPaymentElement({ billingFieldsNever }) {
  const paymentElementContainer = document.querySelector("#payment-element");

  if (paymentElement) {
    paymentElement.destroy();
    paymentElementContainer.innerHTML = "";
  }

  paymentElementBillingFieldsNever = billingFieldsNever;
  paymentElement = checkout.createPaymentElement({
    wallets: {
      googlePay: "auto",
      applePay: "never",
    },
    ...(billingFieldsNever
      ? {
          fields: {
            billingDetails: {
              name: "never",
              email: "never",
              phone: "never",
              address: {
                country: "never",
                postalCode: "never",
              },
            },
          },
        }
      : {}),
  });

  paymentElement.on("ready", () => {
    recordDebugInfo({
      paymentElement: {
        ready: true,
        walletPage: "google",
        billingFieldsNever: paymentElementBillingFieldsNever,
        readyAt: new Date().toISOString(),
      },
    });
  });

  paymentElement.on("loaderror", (event) => {
    console.error("Payment Element load error:", event);
    recordDebugInfo({
      paymentElement: {
        ready: false,
        walletPage: "google",
        billingFieldsNever: paymentElementBillingFieldsNever,
        loadError: event?.error || event,
        loadErrorAt: new Date().toISOString(),
      },
    });
  });

  paymentElement.on("change", (event) => {
    const selectedGooglePay = isGooglePaySelection(event);

    recordDebugInfo({
      paymentElement: {
        complete: event.complete,
        empty: event.empty,
        collapsed: event.collapsed,
        billingFieldsNever: paymentElementBillingFieldsNever,
        googlePaySelected: selectedGooglePay,
        selectedPaymentMethodType: event.value?.type,
        selectedPaymentMethodDetails: event.value,
        lastChangeAt: new Date().toISOString(),
      },
    });

    googlePaySelected = true;
    updateGooglePayPostalCodeVisibility();
  });

  paymentElement.mount("#payment-element");
  paymentElementMounted = true;

  recordDebugInfo({
    paymentElement: {
      walletPage: "google",
      billingFieldsNever: paymentElementBillingFieldsNever,
      remountedAt: new Date().toISOString(),
    },
  });
}

async function handleSubmit(e) {
  e.preventDefault();
  setLoading(true);
  clearMessage();

  try {
    if (!actions) {
      throw new Error("Checkout is still loading. Please try again in a moment.");
    }

    const postalCode = validateGooglePayPostalCode();
    if (!postalCode) {
      setLoading(false);
      return;
    }

    await actions.updateBillingAddress({
      address: {
        postal_code: postalCode,
        country: "US",
      },
    });

    const result = await actions.confirm();
    handleConfirmResult(result);
  } catch (error) {
    console.error("Google Pay confirm threw:", error);
    showMessage(formatError(error));
  } finally {
    setLoading(false);
  }
}

function handleConfirmResult(result) {
  if (result?.error) {
    console.error("Checkout confirm error:", result.error);
    showMessage(formatError(result.error));
  }
}

function updateGooglePayPostalCodeVisibility() {
  const container = document.querySelector("#google-pay-postal-code-container");
  const input = document.querySelector("#google-pay-postal-code");
  const error = document.querySelector("#google-pay-postal-code-errors");
  if (!container || !input || !error) return;

  container.classList.remove("hidden");
  input.required = true;
}

function validateGooglePayPostalCode() {
  const input = document.querySelector("#google-pay-postal-code");
  const error = document.querySelector("#google-pay-postal-code-errors");
  const postalCode = input?.value.trim() ?? "";

  if (!postalCode) {
    input?.classList.add("error");
    if (error) error.textContent = "Enter a ZIP/postal code for Google Pay.";
    showMessage("Enter a ZIP/postal code for Google Pay.");
    return "";
  }

  input.classList.remove("error");
  if (error) error.textContent = "";

  recordDebugInfo({
    googlePayCustomPostalCode: {
      provided: true,
      updatedAt: new Date().toISOString(),
    },
  });

  return postalCode;
}

function isGooglePaySelection(event) {
  return objectContainsString(event, ["google_pay", "googlepay", "google pay"]);
}

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
        "Google Pay page: Payment Element wallets.googlePay='auto', wallets.applePay='never', and billing detail fields are set to 'never'.",
        "Google Pay uses the custom ZIP field and actions.updateBillingAddress() before confirm.",
        "Common Google Pay blockers: non-HTTPS origin, unsupported browser, no Google Pay/Chrome payment method, ineligible country/currency/amount, browser payment permissions/policies, or Stripe account/payment-method settings.",
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
