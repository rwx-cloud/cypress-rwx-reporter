const fs = require("node:fs");
const path = require("node:path");

// Cypress names its screenshots from its own retry counter, so if that disagrees
// with the reporter's attempt number an attempt gets another attempt's image.
// Reads up front, so what it records is the attempt the hook was invoked for.
module.exports = async function attemptNumbers(test, kind, error, context) {
  const line = JSON.stringify({
    title: test.title,
    kind,
    attemptNumber: context.attemptNumber,
    currentRetry:
      typeof test.currentRetry === "function"
        ? test.currentRetry()
        : test.currentRetry,
    state: test.state,
    viewError: test.err ? test.err.message : null,
    argumentError: error ? error.message : null,
  });

  await new Promise((resolve) => setImmediate(resolve));

  const directory = path.join(context.projectRoot, "cypress", "attempts");

  fs.mkdirSync(directory, { recursive: true });
  // One synchronous whole-line write, so concurrent attempts cannot interleave.
  fs.appendFileSync(
    path.join(directory, "attempt-numbers.jsonl"),
    `${line}\n`,
    "utf8",
  );
};
