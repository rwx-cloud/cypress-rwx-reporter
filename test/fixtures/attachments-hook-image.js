const fs = require("node:fs");
const path = require("node:path");

module.exports = function attachments(test, kind, error, context) {
  const file = path.join(context.projectRoot, "artifacts", "hook-shot.png");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "png");

  return { screenshot: { image: file } };
};
