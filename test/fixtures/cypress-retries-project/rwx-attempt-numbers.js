const fs = require("node:fs");
const path = require("node:path");

// Records the attempt number the reporter hands the hook alongside Cypress's own
// retry counter, so the integration test can assert the two agree. Cypress names
// its screenshots from that counter, so a disagreement means a failing test's
// attempt is pointed at another attempt's image.
module.exports = function attemptNumbers(test, kind, error, context) {
  const directory = path.join(context.projectRoot, "cypress", "attempts");

  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(
    path.join(directory, "attempt-numbers.jsonl"),
    `${JSON.stringify({
      title: test.title,
      kind,
      attemptNumber: context.attemptNumber,
      currentRetry:
        typeof test.currentRetry === "function"
          ? test.currentRetry()
          : test.currentRetry,
    })}\n`,
    "utf8",
  );
};
