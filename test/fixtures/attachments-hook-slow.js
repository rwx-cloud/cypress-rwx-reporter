const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = async function attachments(test, kind, error, context) {
  await new Promise((resolve) => setTimeout(resolve, 150));

  const file = path.join(context.projectRoot, "artifacts", "slow.html");

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "<html>", "utf8");

  return { screenshot: { html: file } };
};
