// Cypress mutates one test object in place as a test retries, so after an await
// it describes a later attempt than the hook was invoked for. The view expires
// when the hook yields rather than snapshotting, so a late read throws instead of
// answering for the wrong attempt.

const OPTION = "attachmentsHook";

// Cypress writes an attempt's outcome onto the test only after emitting the event
// for it, so the live test lags a retry by one attempt — `state` "skipped" and no
// `err` on the first. The event object has these three right. Not `currentRetry`:
// the live test already has it right, as a method where the event has a number.
// Measured against cypress@15.18.0.
const ATTEMPT_FIELDS = ["duration", "err", "state"];

function wrappingBreaksProxyInvariant(target, property) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);

  return Boolean(
    descriptor &&
      "value" in descriptor &&
      !descriptor.writable &&
      !descriptor.configurable,
  );
}

function reportedAttemptFields(runnable, reported) {
  if (!reported || reported === runnable || typeof reported !== "object") {
    return null;
  }

  const fields = new Map();

  ATTEMPT_FIELDS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(reported, key)) {
      fields.set(key, reported[key]);
    }
  });

  return fields.size > 0 ? fields : null;
}

function testView(runnable, reported) {
  if (runnable === null || typeof runnable !== "object") {
    return { view: runnable, expire: () => {} };
  }

  const reportedAttempt = reportedAttemptFields(runnable, reported);
  const proxies = new WeakMap();
  let expired = false;

  const refuseWrite = (property) => {
    throw new TypeError(
      `${OPTION} may not modify "${String(property)}" on the test object; it is owned by the reporter.`,
    );
  };
  const refuseExpiredRead = (property) => {
    throw new TypeError(
      `${OPTION} read "${String(property)}" from the test object after awaiting, when it no longer describes the attempt the hook was invoked for. Read the values you need before your first await.`,
    );
  };
  const wrap = (value) => {
    if (typeof value !== "object" || value === null) {
      return value;
    }

    const cached = proxies.get(value);

    if (cached) {
      return cached;
    }

    const proxy = new Proxy(value, {
      get(target, property) {
        if (expired) {
          refuseExpiredRead(property);
        }

        if (target === runnable && reportedAttempt?.has(property)) {
          return wrap(reportedAttempt.get(property));
        }

        // Receiver is the target, not the proxy: internal-slot getters like
        // `err.stack` return undefined when `this` is a proxy. Methods come back
        // unbound, so the hook's own call site still binds `this` to the view.
        const resolved = Reflect.get(target, property, target);

        if (
          typeof resolved === "function" ||
          wrappingBreaksProxyInvariant(target, property)
        ) {
          return resolved;
        }

        return wrap(resolved);
      },
      set: (target, property) => refuseWrite(property),
      defineProperty: (target, property) => refuseWrite(property),
      deleteProperty: (target, property) => refuseWrite(property),
      setPrototypeOf: () => refuseWrite("prototype"),
    });

    proxies.set(value, proxy);

    return proxy;
  };

  return {
    view: wrap(runnable),
    expire: () => {
      expired = true;
    },
  };
}

module.exports = {
  testView,
};
