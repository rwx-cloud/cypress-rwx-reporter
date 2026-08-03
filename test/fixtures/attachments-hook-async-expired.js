module.exports = async function attachments(test) {
  await new Promise((resolve) => setTimeout(resolve, 5));

  return { screenshot: { html: `artifacts/${test.state}.html` } };
};
