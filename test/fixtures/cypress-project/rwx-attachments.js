const fs = require("node:fs");
const path = require("node:path");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slugify(value) {
  return String(value)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
}

// Synchronous on purpose: keep it that way, so a real Cypress run still covers a
// hook that defers nothing. The retries project's hook is the async one.
module.exports = function attachments(test, kind, error, context) {
  if (kind !== "failed") {
    return;
  }

  const directory = path.join(context.projectRoot, "cypress", "attachments");
  const file = path.join(
    directory,
    `${slugify(test.fullTitle())}-${context.attemptNumber}.html`,
  );

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    file,
    [
      "<!doctype html>",
      `<title>${escapeHtml(test.fullTitle())}</title>`,
      `<h1>Attempt ${context.attemptNumber}</h1>`,
      `<pre>${escapeHtml(error ? error.message : "no error")}</pre>`,
      "",
    ].join("\n"),
    "utf8",
  );

  return { screenshot: { html: file } };
};
