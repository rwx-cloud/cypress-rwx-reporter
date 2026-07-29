const fs = require("node:fs");
const path = require("node:path");

// Stateless on purpose: the require cache means every test pointing at this
// fixture shares a single module instance. Writes the file it names, the way a
// real hook does, so the reporter's existence check is satisfied.
module.exports = function attachments(test, kind, error, context) {
  const name = [
    "hook",
    kind,
    context.attemptNumber,
    error ? "error" : "no-error",
    context.screenshot ? "screenshot" : "no-screenshot",
  ].join("-");
  const file = path.join(context.projectRoot, "artifacts", `${name}.html`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<html><body>${name}</body></html>`);

  return { screenshot: { html: file } };
};
