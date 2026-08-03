const fs = require("node:fs/promises");
const path = require("node:path");

function slug(value) {
  return String(value)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

// Reads up front, then does the IO. Everything read goes into the filename, so
// the results file records which attempt the hook saw.
module.exports = async function attachments(test, kind, error, context) {
  const name = [
    kind,
    context.attemptNumber,
    typeof test.currentRetry === "function"
      ? test.currentRetry()
      : test.currentRetry,
    test.state,
    slug(test.fullTitle()),
    // Off the view rather than the `error` argument, which would agree anyway.
    test.err ? slug(test.err.message) : "no-error",
  ].join("-");

  await new Promise((resolve) => setTimeout(resolve, 5));

  const file = path.join(context.projectRoot, "artifacts", `${name}.html`);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `<html><body>${name}</body></html>`, "utf8");

  return { screenshot: { html: file } };
};
