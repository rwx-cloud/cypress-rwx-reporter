const fs = require("node:fs");
const path = require("node:path");

const OPTION = "attachmentsHook";
const SCREENSHOT_KEYS = ["html", "image"];
const RETURN_KEYS = ["screenshot"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function describe(value) {
  if (value === null) {
    return "null";
  }

  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

function quoteList(keys) {
  return keys.map((key) => `"${key}"`).join(", ");
}

function unsupportedKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function loadAttachmentsHook(configured, projectRoot) {
  if (configured === undefined || configured === null || configured === "") {
    return null;
  }

  if (typeof configured !== "string") {
    throw new Error(
      `${OPTION} must be a path to a JavaScript file, received ${describe(configured)}.`,
    );
  }

  if (configured.trim().length === 0) {
    return null;
  }

  const resolved = path.resolve(projectRoot, configured);
  let loaded;

  try {
    loaded = require(resolved);
  } catch (error) {
    throw new Error(loadErrorMessage(configured, resolved, error), {
      cause: error,
    });
  }

  const hook =
    typeof loaded === "function"
      ? loaded
      : loaded && typeof loaded.default === "function"
        ? loaded.default
        : null;

  if (!hook) {
    throw new Error(
      `${OPTION} "${configured}" must export a function (module.exports = function attachments(test, kind, error, context) { ... }).`,
    );
  }

  if (hook.constructor && hook.constructor.name === "AsyncFunction") {
    throw new Error(
      `${OPTION} "${configured}" exports an async function. The reporter is synchronous and cannot await it. Make the hook synchronous.`,
    );
  }

  return hook;
}

function loadErrorMessage(configured, resolved, error) {
  if (error.code === "MODULE_NOT_FOUND" && !fs.existsSync(resolved)) {
    return `Could not load ${OPTION} "${configured}": no such file at ${resolved}.`;
  }

  if (error.code === "ERR_REQUIRE_ESM") {
    return `Could not load ${OPTION} "${configured}" (${resolved}): this Node version cannot require an ES module. Upgrade to Node 20.19+ or 22.12+, or use CommonJS.`;
  }

  return `Could not load ${OPTION} "${configured}" (${resolved}): ${error.message}`;
}

const readOnlyCache = new WeakMap();

function readOnly(value) {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const cached = readOnlyCache.get(value);

  if (cached) {
    return cached;
  }

  const refuse = (property) => {
    throw new TypeError(
      `${OPTION} may not modify "${String(property)}" on the test object; it is owned by the reporter.`,
    );
  };
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      const resolved = Reflect.get(target, property, receiver);

      // Unbound so `this` is the proxy and a mutating method is refused too.
      if (typeof resolved === "function") {
        return resolved;
      }

      return readOnly(resolved);
    },
    set: (target, property) => refuse(property),
    defineProperty: (target, property) => refuse(property),
    deleteProperty: (target, property) => refuse(property),
    setPrototypeOf: () => refuse("prototype"),
  });

  readOnlyCache.set(value, proxy);

  return proxy;
}

function callAttachmentsHook(hook, args, warn) {
  try {
    return hook(...args);
  } catch (error) {
    warn(`${OPTION} threw: ${error && error.stack ? error.stack : error}`);

    return null;
  }
}

function validateScreenshot(value, warn, projectRoot) {
  if (!isPlainObject(value)) {
    warn(
      `${OPTION} returned "screenshot" as ${describe(value)}; expected an object with "html" and/or "image". Ignoring it.`,
    );

    return {};
  }

  const extra = unsupportedKeys(value, SCREENSHOT_KEYS);

  if (extra.length > 0) {
    warn(
      `${OPTION} returned unsupported key(s) ${quoteList(extra)} on "screenshot"; only ${quoteList(SCREENSHOT_KEYS)} are supported. Ignoring them.`,
    );
  }

  return SCREENSHOT_KEYS.reduce((screenshot, key) => {
    if (value[key] === undefined) {
      return screenshot;
    }

    if (!isNonEmptyString(value[key])) {
      warn(
        `${OPTION} returned "screenshot.${key}" as ${describe(value[key])}; expected a non-empty string. Ignoring it.`,
      );

      return screenshot;
    }

    const resolved = path.resolve(projectRoot, value[key]);

    if (!fs.existsSync(resolved)) {
      warn(
        `${OPTION} returned "screenshot.${key}" pointing at a file that does not exist: ${resolved}. RWX skips attachments it cannot read.`,
      );
    }

    screenshot[key] = resolved;

    return screenshot;
  }, {});
}

function validateAttachments(value, warn, projectRoot) {
  if (value === undefined || value === null) {
    return null;
  }

  if (isPlainObject(value) && typeof value.then === "function") {
    warn(
      `${OPTION} returned a Promise; the reporter is synchronous and cannot await it. Do the work synchronously.`,
    );

    return null;
  }

  if (!isPlainObject(value)) {
    warn(
      `${OPTION} returned ${describe(value)}; expected an object with ${quoteList(RETURN_KEYS)}. Ignoring it.`,
    );

    return null;
  }

  const extra = unsupportedKeys(value, RETURN_KEYS);

  if (extra.length > 0) {
    warn(
      `${OPTION} returned unsupported key(s) ${quoteList(extra)}; only ${quoteList(RETURN_KEYS)} is supported. Ignoring them.`,
    );
  }

  if (value.screenshot === undefined) {
    return null;
  }

  const screenshot = validateScreenshot(value.screenshot, warn, projectRoot);

  return Object.keys(screenshot).length > 0 ? { screenshot } : null;
}

module.exports = {
  callAttachmentsHook,
  loadAttachmentsHook,
  readOnly,
  validateAttachments,
};
