module.exports = function attachments(test, kind, error) {
  // The mistake the contract has to survive: assuming the attempt failed.
  return { screenshot: { html: error.message } };
};
