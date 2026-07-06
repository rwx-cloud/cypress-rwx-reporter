# cypress-rwx-reporter

A Cypress reporter that writes [RWX v1 test results](https://github.com/rwx-research/test-results-schema) for Captain.

## Install

```sh
npm install --save-dev cypress-rwx-reporter
```

## Configure

```js
const { defineConfig } = require("cypress");

module.exports = defineConfig({
  reporter: "cypress-rwx-reporter",
  reporterOptions: {
    outputFile: "rwx-results/results-[hash].json",
  },
});
```

The reporter defaults to `rwx-results/results-[hash].json`. Cypress runs each spec separately, so `[hash]` keeps later specs from overwriting earlier reports.

## Output

The reporter emits RWX v1 JSON with:

- `framework` set to JavaScript Cypress
- final test results in `test.attempt`
- earlier retry attempts in `test.pastAttempts`
- failure screenshots attached as `attempt.meta.fileAttachments`
- a `attempt.meta.screenshot.image` alias for Captain compatibility

Failure screenshots are discovered from Cypress's default screenshot layout:

```text
cypress/screenshots/<spec path>/<suite -- test> (failed).png
cypress/screenshots/<spec path>/<suite -- test> (failed) (attempt 2).png
```

If your Cypress config changes `screenshotsFolder`, pass the same value:

```js
module.exports = defineConfig({
  screenshotsFolder: "tmp/screenshots",
  reporter: "cypress-rwx-reporter",
  reporterOptions: {
    screenshotsFolder: "tmp/screenshots",
  },
});
```

## Options

- `outputFile`, `resultsFile`, or `rwxFile`: output path. Defaults to `rwx-results/results-[hash].json`.
- `screenshotsFolder`: Cypress screenshots folder. Defaults to `cypress/screenshots`.
- `projectRoot`: project root for relative output and screenshot paths. Defaults to `process.cwd()`.
- `includeScreenshots`: set to `false` to skip screenshot lookup.
- `toConsole`: set to `true` to print the RWX JSON to stdout.
