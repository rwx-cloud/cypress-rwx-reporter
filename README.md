# @rwx-cloud/cypress-rwx-reporter

A Cypress reporter that writes [RWX v1 test results](https://github.com/rwx-research/test-results-schema) for use in [RWX](https://rwx.com).

## Install

```sh
npm install --save-dev @rwx-cloud/cypress-rwx-reporter
```

## Configure

```js
const { defineConfig } = require("cypress");

module.exports = defineConfig({
  reporter: "@rwx-cloud/cypress-rwx-reporter",
  reporterOptions: {
    outputFile: "rwx-results/results-[hash].json",
  },
});
```

The reporter defaults to `rwx-results/results-[hash].json`. Cypress runs each spec separately, so `[hash]` keeps later specs from overwriting earlier reports.

## Output

The reporter emits RWX v1 JSON. Unlike other Cypress reporters, all retry attempts of a test will appear in the test results. Additionally, if Cypress produced screenshots for a failing test, the screenshot path will be attached to the test in `attempt.meta.fileAttachments` and `attempt.meta.screenshot.image`.

Failure screenshots are discovered from Cypress's default screenshot layout:

```text
cypress/screenshots/<spec path>/<suite -- test> (failed).png
cypress/screenshots/<spec path>/<suite -- test> (failed) (attempt 2).png
```

If your Cypress config changes `screenshotsFolder`, configure the `screenshotsFolder` in `reporterOptions` as well:

```js
module.exports = defineConfig({
  screenshotsFolder: "tmp/screenshots",
  reporter: "@rwx-cloud/cypress-rwx-reporter",
  reporterOptions: {
    screenshotsFolder: "tmp/screenshots",
  },
});
```

## Options

- `outputFile`, `resultsFile`, or `rwxFile`: output path. Defaults to `rwx-results/results-[hash].json`.
- `screenshotsFolder`: Cypress screenshots folder. Defaults to `cypress/screenshots`.
- `projectRoot`: optional project root override for relative output and screenshot paths. Defaults to Cypress's project root when available, then `process.cwd()`.
- `includeScreenshots`: set to `false` to skip screenshot lookup.
- `toConsole`: set to `true` to print the RWX JSON to stdout.
- `adjustAttempt`: optional filename whose default export function is used to adjust the attempt before it's added. For example, to attach extra files. `module.exports = function adjustAttempt(attempt, test, kind, error, context) {}`
