module.exports = function attachments(test) {
  test.title = "hijacked";

  return { screenshot: { html: "artifacts/never.html" } };
};
