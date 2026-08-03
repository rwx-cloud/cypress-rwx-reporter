const path = require("node:path");

module.exports = {
  allowCypressEnv: false,
  // Hook failures are not a retry problem, so this project keeps retries off.
  retries: { runMode: 0, openMode: 0 },
  e2e: {
    specPattern: "cypress/e2e/**/*.cy.js",
    supportFile: false,
  },
  reporter: path.resolve(__dirname, "../../..", "index.js"),
  reporterOptions: {
    outputFile: "rwx-results/[spec]-[hash].json",
    projectRoot: __dirname,
  },
  screenshotOnRunFailure: true,
  screenshotsFolder: "cypress/screenshots",
  trashAssetsBeforeRuns: true,
  video: false,
};
