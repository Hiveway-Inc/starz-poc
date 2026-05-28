let stripe;
let elements;
let appConfig;
let latestDebugInfo = {};
let currentClientSecret;
let setupComplete = false;

document.querySelector("#setup-form").addEventListener("submit", handleSubmit);

window.addEventListener("error", (event) => {
  console.error("Window error:", event.error || event.message);
  showMessage(formatError(event.error || event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  showMessage(formatError(event.reason));
});

initialize().catch((error) => {
  console.error("SetupIntent initialization failed:", error);
  showMessage(formatError(error));
  setLoading(false);
});

async function initialize() {
  setLoading(true);
  clearMessage();

  appConfig = await fetchJson("/config");
  stripe = Stripe(appConfig.publishableKey);

  const returnedClientSecret = new URLSearchParams(window.location.search).get(
    "setup_intent_client_secret",
  );

  if (returnedClientSecret) {
    currentClientSecret = returnedClientSecret;
    await showSetupIntentResult(returnedClientSecret);
    setLoading(false);
    return;
  }

  const response = await fetch("/create-setup-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const payload = await parseJsonResponse(response);
  updateDebugInfo(payload, response.status);

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || "Failed to create setup intent.");
  }

  currentClientSecret = payload.clientSecret;
  document.querySelector("#setup-intent-id").textContent = payload.setupIntentId || "Unavailable";

  elements = stripe.elements({
    clientSecret: currentClientSecret,
    appearance: { theme: "stripe" },
  });

  const paymentElement = elements.create("payment", {
    wallets: {
      googlePay: "auto",
      applePay: "never",
    },
  });

  paymentElement.on("ready", () => {
    recordDebugInfo({
      paymentElement: {
        ready: true,
        flow: "setup_intent_google_pay",
        readyAt: new Date().toISOString(),
      },
    });
  });

  paymentElement.on("loaderror", (event) => {
    console.error("Payment Element load error:", event);
    recordDebugInfo({
      paymentElement: {
        ready: false,
        flow: "setup_intent_google_pay",
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
        googlePaySelected: objectContainsString(event, ["google_pay", "googlepay", "google pay"]),
        selectedPaymentMethodType: event.value?.type,
        selectedPaymentMethodDetails: event.value,
        lastChangeAt: new Date().toISOString(),
      },
    });
  });

  paymentElement.mount("#payment-element");
  recordDebugInfo({ browserWalletChecks: collectBrowserWalletDebug() });
  setLoading(false);
}

async function handleSubmit(event) {
  event.preventDefault();
  setLoading(true);
  clearMessage();

  try {
    if (!stripe || !elements || !currentClientSecret) {
      throw new Error("Setup form is still loading. Please try again in a moment.");
    }

    const result = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/setup.html`,
      },
      redirect: "if_required",
    });

    if (result.error) {
      console.error("SetupIntent confirm error:", result.error);
      showMessage(formatError(result.error));
      recordDebugInfo({ confirmError: result.error });
      return;
    }

    if (result.setupIntent) {
      handleSetupIntent(result.setupIntent);
    }
  } catch (error) {
    console.error("SetupIntent confirm threw:", error);
    showMessage(formatError(error));
  } finally {
    setLoading(false);
  }
}

async function showSetupIntentResult(clientSecret) {
  const { setupIntent, error } = await stripe.retrieveSetupIntent(clientSecret);

  if (error) {
    showMessage(formatError(error));
    recordDebugInfo({ retrieveError: error });
    return;
  }

  handleSetupIntent(setupIntent);
}

function handleSetupIntent(setupIntent) {
  document.querySelector("#setup-intent-id").textContent = setupIntent.id || "Unavailable";
  recordDebugInfo({
    setupIntentResult: {
      id: setupIntent.id,
      status: setupIntent.status,
      paymentMethod: setupIntent.payment_method,
      usage: setupIntent.usage,
      customer: setupIntent.customer,
      updatedAt: new Date().toISOString(),
    },
  });

  if (setupIntent.status === "succeeded") {
    setupComplete = true;
    showMessage("Payment method saved to the existing customer.");
    document.querySelector("#button-text").textContent = "Saved";
    document.querySelector("#submit").disabled = true;
  } else {
    showMessage(`SetupIntent status: ${setupIntent.status}`);
  }
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
        "Setup page creates a SetupIntent with the existing STRIPE_CUSTOMER_ID.",
        "Payment Element is configured with wallets.googlePay='auto' and wallets.applePay='never'.",
        "Google Pay saves a card-backed payment method to the customer when the SetupIntent succeeds.",
        "Google Pay still requires an eligible browser/device, HTTPS, and Stripe Dashboard payment method settings.",
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
    document.querySelector("#submit").disabled = setupComplete;
    document.querySelector("#spinner").classList.add("hidden");
    document.querySelector("#button-text").classList.remove("hidden");
  }
}
