module.exports = async function attachments(test) {
  await new Promise((resolve) => setTimeout(resolve, 5));

  test.title = "hijacked";

  return { screenshot: { html: "artifacts/never.html" } };
};
