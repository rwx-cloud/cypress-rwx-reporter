const path = require("node:path");
const { defineConfig } = require("cypress");

module.exports = defineConfig({
  allowCypressEnv: false,
  e2e: {
    specPattern: "cypress/e2e/**/*.cy.js",
    supportFile: false,
  },
  reporter: path.resolve(__dirname, "../../..", "index.js"),
  reporterOptions: {
    attachmentsHook: "rwx-attempt-numbers.js",
    outputFile: "rwx-results/results-[spec]-[hash].json",
  },
  screenshotOnRunFailure: true,
  screenshotsFolder: "cypress/screenshots",
  trashAssetsBeforeRuns: true,
  video: false,
});
