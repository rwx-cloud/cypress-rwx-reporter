module.exports = async function attachments() {
  await new Promise((resolve) => setTimeout(resolve, 1));

  throw new Error("async boom");
};
