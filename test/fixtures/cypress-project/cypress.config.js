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
    outputFile: "rwx-results/results-[hash].json",
    projectRoot: __dirname,
  },
  screenshotOnRunFailure: true,
  screenshotsFolder: "cypress/screenshots",
  trashAssetsBeforeRuns: true,
  video: false,
});
