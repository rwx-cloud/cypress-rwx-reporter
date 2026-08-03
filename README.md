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

The reporter emits RWX v1 JSON. Unlike other Cypress reporters, all retry attempts of a test will appear in the test results. Additionally, if Cypress produced a screenshot for a failing test, the path is attached to the attempt as `attempt.meta.screenshot.image`. An [attachments hook](#custom-attachments) can add an HTML snapshot alongside it as `attempt.meta.screenshot.html`.

Failure screenshots are discovered from Cypress's default screenshot layout:

```text
cypress/screenshots/<spec path>/<suite -- test> (failed).png
cypress/screenshots/<spec path>/<suite -- test> (failed) (attempt 2).png
```

### Failing hooks

A failing `before`, `beforeEach`, `after`, or `afterEach` hook is not a test, so it is reported in `otherErrors` rather than as one:

```json
{
  "message": "expected 'hook' to equal 'broken'",
  "exception": "AssertionError",
  "location": { "file": "cypress/e2e/login.cy.js" },
  "meta": {
    "hook": "before each",
    "screenshot": { "image": "cypress/screenshots/login.cy.js/login -- loads -- before each hook (failed).png" }
  }
}
```

- When a `before` or `beforeEach` hook fails, tests which are stopped from running are `skipped`. This differs slightly from Cypress's classification, but is most accurate and stops a flaky before hook from pinning blame on a test.
- A test whose body passed before its `after` or `afterEach` hook failed is `successful`.

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

## Custom attachments

To attach anything beyond Cypress's own failure screenshots, point `attachmentsHook` at a
JavaScript file. Its exported function runs once per attempt and returns a description of what
to attach.

```js
module.exports = defineConfig({
  reporter: "@rwx-cloud/cypress-rwx-reporter",
  reporterOptions: {
    attachmentsHook: "cypress/rwx-attachments.js",
  },
});
```

```js
// cypress/rwx-attachments.js
module.exports = function attachments(test, kind, error, context) {
  if (kind !== "failed") {
    return;
  }

  // `error` may be undefined even for a failed attempt.
  const file = writeReport(test, error ? error.message : "");

  return { screenshot: { html: file } };
};
```

### Arguments

- `test`: the Mocha test object, wrapped so it is read-only.
- `kind`: `"successful"`, `"failed"`, or `"skipped"`.
- `error`: the failure, always `undefined` for passing and skipped attempts.
- `context`: `{ attemptNumber, startedAt, finishedAt, screenshot, projectRoot }`.

### Return value

Return nothing to attach nothing. Otherwise return an object with a `screenshot`:

```js
{
  // The attempt's screenshot slots, merged key by key: setting `html` leaves
  // an `image` the reporter discovered in place, and vice versa.
  screenshot: {
    html: "artifacts/report.html", // surfaced in RWX as the HTML snapshot
    image: "artifacts/shot.png",   // surfaced in RWX as the screenshot
  },
}
```

Both keys are optional, an empty object is the same as omitting it, and paths
may be absolute or relative to the project root.

`screenshot` designates the attempt's visual: RWX uploads whichever of `image`
and `html` you set and renders them on the attempt. Use `image` for a PNG and
`html` for a self-contained page, which is useful when the visual is not a
single image, such as a side-by-side diff.

Setting a key replaces what the reporter found for that key, so returning an
`image` overrides the Cypress screenshot it discovered. Keys you leave out are
untouched — returning only `html` keeps the discovered `image` alongside it.

RWX only uploads screenshots for attempts that did not succeed, so returning one
for a passing attempt has no visible effect.

### Behaviour

The hook must be **synchronous** — the reporter cannot await a promise, so an
`async` function is rejected at startup. It is required once per process, so
module-level state persists across specs, and it runs for every attempt.

CommonJS (`module.exports = …`) always works. ES modules (`export default …`)
work on Node 20.19+ and 22.12+, and TypeScript hooks work on Node 23.6+, both
via Node's own support for requiring them — but a hook using top-level `await`
can never be loaded. On older Node you get a clear error at startup.

A hook file that is missing or fails to load stops the run immediately.
Once loaded, errors are contained and logged, so results are always written.

## Options

- `outputFile`, `resultsFile`, or `rwxFile`: output path. Defaults to `rwx-results/results-[hash].json`.
- `screenshotsFolder`: Cypress screenshots folder. Defaults to `cypress/screenshots`.
- `specFile`: Rarely needed. Spec path to look for screenshots under, overriding the path recorded on the test.
- `projectRoot`: optional project root override for relative output and screenshot paths. Defaults to Cypress's project root when available, then `process.cwd()`.
- `includeScreenshots`: set to `false` to skip screenshot lookup.
- `attachmentsHook`: path to a JavaScript file exporting a function that returns an extra screenshot or HTML snapshot per attempt. Absolute, or relative to the project root. See [Custom attachments](#custom-attachments).
- `toConsole`: set to `true` to print the RWX JSON to stdout.
