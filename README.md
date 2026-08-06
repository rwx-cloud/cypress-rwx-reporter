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

When a spec runs more than once and [`trashAssetsBeforeRuns`](https://docs.cypress.io/app/references/configuration) is off, the screenshots folder holds screenshots from every invocation. Cypress does not overwrite the earlier one — it writes the new one alongside it as `… (failed) (1).png` — so a filename on its own no longer says which invocation produced it. This comes up when retries are driven from outside Cypress, as [Captain](https://www.rwx.com/docs/captain) does: each retry is a fresh Cypress process, on its own first attempt.

The reporter resolves each attempt to a screenshot this invocation wrote, by modification time, so a retried attempt is not attached the previous invocation's image. Where those timestamps are unusable it falls back to matching on filename alone. Nothing to configure.

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
to attach. It may be `async`.

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
module.exports = async function attachments(test, kind, error, context) {
  if (kind !== "failed") {
    return;
  }

  // Read the test before awaiting anything. See "The test object".
  const title = test.fullTitle();

  // `error` may be undefined even for a failed attempt.
  const file = await writeReport(title, error ? error.message : "");

  return { screenshot: { html: file } };
};
```

### Arguments

- `test`: the Mocha test object, read-only, and valid only until the hook awaits.
  See [The test object](#the-test-object).
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

### Reading the test object

`test` is the Mocha test object, describing the one attempt the hook was invoked
for. `state`, `err`, and `duration` are that attempt's. Writes to it are refused.

**Read what you need before your first `await`.** Once the hook awaits, `test` no
longer describes the attempt it was invoked for, so reads throw instead of
answering for a different one:

```js
module.exports = async function attachments(test, kind, error, context) {
  const title = test.fullTitle(); // read up front

  await somethingSlow();

  test.state; // throws
};
```

### Behaviour

The hook runs once per attempt, including attempts that succeeded and tests
Cypress never started. Module-level state persists across specs.

The hook may be `async`, or return a promise. **Return a promise for work that has
to finish before the results are written**: the reporter waits for the promises the
hook returns, and knows nothing about work the hook starts without returning one.

That wait is bounded by [`attachmentsTimeout`](#options), 30 seconds by default.
When it expires the reporter logs a warning, writes the results without the
attachments that had not arrived, and carries on.

CommonJS (`module.exports = …`) always works. ES modules (`export default …`)
work on Node 20.19+ and 22.12+, and TypeScript hooks work on Node 23.6+, both
via Node's own support for requiring them. The module is loaded synchronously, at
startup, so it may not use top-level `await` — put awaited work inside the hook,
which may be `async`. On older Node you get a clear error at startup.

A hook file that is missing or fails to load stops the run immediately. Once
loaded, errors are contained and logged — a thrown exception and a rejected
promise alike — so results are always written.

## Options

- `outputFile`, `resultsFile`, or `rwxFile`: output path. Defaults to `rwx-results/results-[hash].json`.
- `screenshotsFolder`: Cypress screenshots folder. Defaults to `cypress/screenshots`.
- `specFile`: Rarely needed. Spec path to look for screenshots under, overriding the path recorded on the test.
- `projectRoot`: optional project root override for relative output and screenshot paths. Defaults to Cypress's project root when available, then `process.cwd()`.
- `includeScreenshots`: set to `false` to skip screenshot lookup.
- `attachmentsHook`: path to a JavaScript file exporting a function that returns an extra screenshot or HTML snapshot per attempt. Absolute, or relative to the project root. See [Custom attachments](#custom-attachments).
- `attachmentsTimeout`: how long to wait, in milliseconds, for outstanding `attachmentsHook` work before writing a spec's results without it. Defaults to `30000`.
- `toConsole`: set to `true` to print the RWX JSON to stdout.
