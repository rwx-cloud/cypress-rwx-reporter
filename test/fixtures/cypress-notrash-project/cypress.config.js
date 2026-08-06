const path = require("node:path");
const { defineConfig } = require("cypress");

// The one fixture that keeps Cypress's earlier screenshots around, which is what
// a Captain retry of a project with `trashAssetsBeforeRuns` off looks like on
// disk. Cypress-level retries are off: the retry comes from a second invocation.
module.exports = defineConfig({
  allowCypressEnv: false,
  retries: { runMode: 0, openMode: 0 },
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
  trashAssetsBeforeRuns: false,
  video: false,
});
