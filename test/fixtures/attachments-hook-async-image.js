const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = async function attachments(test, kind, error, context) {
  await new Promise((resolve) => setTimeout(resolve, 5));

  const file = path.join(context.projectRoot, "artifacts", "async-hook.png");

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "png", "utf8");

  return { screenshot: { image: file } };
};
