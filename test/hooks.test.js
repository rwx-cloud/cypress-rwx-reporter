// Every event sequence below was recorded from cypress@15.18.0, with and without
// retries, so these describe what Cypress reports rather than what Mocha's docs
// suggest it would.
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const RwxReporter = require("../index");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cypress-rwx-reporter-"));
}

// Real Mocha puts these on the prototype. The reporter only ever calls them.
function withTitles(runnable) {
  runnable.titlePath = function titlePath() {
    const ancestry = this.parent ? this.parent.titlePath() : [];

    return this.title ? [...ancestry, this.title] : ancestry;
  };
  runnable.fullTitle = function fullTitle() {
    return this.titlePath().join(" ");
  };

  return runnable;
}

// Only the root suite carries the spec file; everything below reaches it through
// `parent`.
function createRootSuite(file) {
  return withTitles({
    type: "suite",
    title: "",
    file,
    root: true,
    tests: [],
    suites: [],
  });
}

function addSuite(parent, title) {
  const suite = withTitles({
    type: "suite",
    title,
    file: null,
    parent,
    root: false,
    tests: [],
    suites: [],
  });

  parent.suites.push(suite);

  return suite;
}

function addTest(suite, title) {
  const mochaTest = withTitles({
    type: "test",
    title,
    file: null,
    parent: suite,
    pending: false,
    state: "skipped",
  });

  suite.tests.push(mochaTest);

  return mochaTest;
}

function assertionError(message) {
  const error = new Error(message);

  error.name = "AssertionError";

  return error;
}

// What Cypress passes to `fail` when a hook throws: `type: "test"`, the hook's
// title in place of a test's, and `failedFromHookId` set.
function createHookFailure(suite, hookName, testTitle, error) {
  return withTitles({
    type: "test",
    title: `"${hookName}" hook for "${testTitle}"`,
    file: null,
    parent: suite,
    pending: false,
    state: "failed",
    err: error,
    failedFromHookId: "h1",
  });
}

// The `retry` event for a hook failure carries the test's own title, degraded the
// way every retry event is — cypress-io/cypress#27732 — but marked as the hook's.
function createHookRetry(testTitle, hookName) {
  return {
    title: testTitle,
    hookName,
    failedFromHookId: "h1",
    failedFromHookName: hookName,
    titlePath() {
      return null;
    },
    fullTitle() {
      return null;
    },
  };
}

// The same event for an ordinary body failure, which carries no hook marking.
function createDegradedRetry(testTitle) {
  return {
    title: testTitle,
    titlePath() {
      return null;
    },
    fullTitle() {
      return null;
    },
  };
}

// A test that recovered on a retry keeps `failedFromHookName` and loses
// `failedFromHookId` — the hook failed, but not fatally.
function recoveredFromHook(mochaTest, hookName) {
  mochaTest.state = "passed";
  mochaTest.failedFromHookName = hookName;
  delete mochaTest.failedFromHookId;
  mochaTest.duration = 12;

  return mochaTest;
}

// On `test end` Cypress hands back the real test, stamped with the hook.
function endedFromHook(mochaTest, hookName, error) {
  mochaTest.state = "failed";
  mochaTest.hookName = hookName;
  mochaTest.failedFromHookName = hookName;
  mochaTest.failedFromHookId = "h1";
  mochaTest.err = error;
  mochaTest.duration = 96;

  return mochaTest;
}

function createReporter() {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  return {
    runner,
    report: () =>
      JSON.parse(fs.readFileSync(path.join(projectRoot, outputFile), "utf8")),
  };
}

function names(report) {
  return report.tests.map((result) => result.name).sort();
}

function statusOf(report, name) {
  return report.tests.find((result) => result.name === name).attempt.status.kind;
}

test("reports a failing beforeEach as an other error, not as a test", () => {
  const { runner, report } = createReporter();
  const spec = "cypress/e2e/before-each-hook.cy.js";
  const root = createRootSuite(spec);
  const suite = addSuite(root, "beforeEach fails");
  const first = addTest(suite, "never runs");
  const error = assertionError("expected 'hook' to equal 'broken'");

  addTest(suite, "also never runs");

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", first);
  runner.emit(
    "fail",
    createHookFailure(suite, "before each", "never runs", error),
    error,
  );
  runner.emit("test end", endedFromHook(first, "before each", error));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.deepEqual(names(results), [
    "beforeEach fails also never runs",
    "beforeEach fails never runs",
  ]);
  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.skipped, 2);
  assert.equal(results.summary.failed, 0);
  assert.equal(results.summary.otherErrors, 1);
  assert.equal(results.summary.status.kind, "failed");
  assert.equal(results.otherErrors.length, 1);
  assert.equal(results.otherErrors[0].message, error.message);
  assert.equal(results.otherErrors[0].exception, "AssertionError");
  assert.equal(results.otherErrors[0].location.file, spec);
  results.tests.forEach((result) =>
    assert.equal(result.location.file, spec, `${result.name} has no location`),
  );
});

test("reports a failing before as an other error, without a test event", () => {
  const { runner, report } = createReporter();
  const spec = "cypress/e2e/before-hook.cy.js";
  const root = createRootSuite(spec);
  const suite = addSuite(root, "before fails");
  const first = addTest(suite, "never runs");
  const error = assertionError("expected 'before' to equal 'broken'");

  addTest(suite, "also never runs");

  // A failing `before all` opens no `test` window at all: the failure and the
  // `test end` arrive with nothing between them.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit(
    "fail",
    createHookFailure(suite, "before all", "never runs", error),
    error,
  );
  runner.emit("suite end", suite);
  runner.emit("test end", endedFromHook(first, "before all", error));
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.deepEqual(names(results), [
    "before fails also never runs",
    "before fails never runs",
  ]);
  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.skipped, 2);
  assert.equal(results.summary.failed, 0);
  assert.equal(results.summary.otherErrors, 1);
  assert.equal(results.summary.status.kind, "failed");
});

test("reports tests in a suite the failing hook never entered", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/before-each-nested.cy.js");
  const outer = addSuite(root, "outer with broken beforeEach");
  const inner = addSuite(outer, "inner");
  const outerTest = addTest(outer, "outer never runs");
  const error = assertionError("expected 'hook' to equal 'broken'");

  addTest(inner, "inner never runs");

  // Cypress emits no `suite` event for `inner` — it skips the suite outright.
  runner.emit("suite", root);
  runner.emit("suite", outer);
  runner.emit("test", outerTest);
  runner.emit(
    "fail",
    createHookFailure(outer, "before each", "outer never runs", error),
    error,
  );
  runner.emit("test end", endedFromHook(outerTest, "before each", error));
  runner.emit("suite end", outer);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.deepEqual(names(results), [
    "outer with broken beforeEach inner inner never runs",
    "outer with broken beforeEach outer never runs",
  ]);
  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.skipped, 2);
  assert.equal(results.summary.otherErrors, 1);
  assert.deepEqual(
    results.tests.find((result) => result.name.endsWith("inner never runs"))
      .lineage,
    ["outer with broken beforeEach", "inner", "inner never runs"],
  );
});

test("keeps a test whose body passed when its after hook fails", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/after-hook.cy.js");
  const suite = addSuite(root, "after fails");
  const passing = addTest(suite, "passes");
  const error = assertionError("expected 'after' to equal 'broken'");

  // No `pass` even though the body succeeded: `test` → `fail` (with the hook's
  // title) → `test end`.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", passing);
  runner.emit(
    "fail",
    createHookFailure(suite, "after all", "passes", error),
    error,
  );
  runner.emit("test end", endedFromHook(passing, "after all", error));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.deepEqual(names(results), ["after fails passes"]);
  assert.equal(results.summary.tests, 1);
  assert.equal(results.summary.successful, 1);
  assert.equal(results.summary.failed, 0);
  assert.equal(results.summary.otherErrors, 1);
  assert.equal(results.summary.status.kind, "failed");
});

test("keeps every test when an after hook fails at the end of a suite", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/after-all-multi.cy.js");
  const suite = addSuite(root, "after all fails, several tests");
  const first = addTest(suite, "first passes");
  const second = addTest(suite, "second passes");
  const error = assertionError("expected 'after' to equal 'broken'");

  // `after all` attaches to the last test that ran, so only it loses its `pass`.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", first);
  runner.emit("pass", first);
  runner.emit("test end", first);
  runner.emit("test", second);
  runner.emit(
    "fail",
    createHookFailure(suite, "after all", "second passes", error),
    error,
  );
  runner.emit("test end", endedFromHook(second, "after all", error));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.deepEqual(names(results), [
    "after all fails, several tests first passes",
    "after all fails, several tests second passes",
  ]);
  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.successful, 2);
  assert.equal(results.summary.otherErrors, 1);
  assert.equal(results.summary.status.kind, "failed");
});

test("keeps a test whose body passed when its afterEach fails", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/after-each-hook.cy.js");
  const suite = addSuite(root, "afterEach fails");
  const passing = addTest(suite, "passes its body");
  const error = assertionError("expected 'afterEach' to equal 'broken'");

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", passing);
  runner.emit(
    "fail",
    createHookFailure(suite, "after each", "passes its body", error),
    error,
  );
  runner.emit("test end", endedFromHook(passing, "after each", error));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.deepEqual(names(results), ["afterEach fails passes its body"]);
  assert.equal(results.summary.tests, 1);
  assert.equal(results.summary.successful, 1);
  assert.equal(results.summary.otherErrors, 1);
  assert.equal(results.summary.status.kind, "failed");
});

test("separates a test's own failure from its afterEach failure", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/body-and-hook.cy.js");
  const suite = addSuite(root, "body and hook both fail");
  const failing = addTest(suite, "fails its body");
  const bodyError = assertionError("expected 1 to equal 2");
  const hookError = assertionError("expected 'afterEach' to equal 'broken'");

  // Two `fail` events for one test: its own, then the hook's. Only the second
  // carries `failedFromHookId`.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", failing);
  runner.emit("fail", failing, bodyError);
  runner.emit(
    "fail",
    createHookFailure(suite, "after each", "fails its body", hookError),
    hookError,
  );
  runner.emit("test end", endedFromHook(failing, "after each", hookError));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  // The hook's failure is neither a second attempt nor a test of its own.
  assert.deepEqual(names(results), ["body and hook both fail fails its body"]);
  assert.equal(results.summary.tests, 1);
  assert.equal(results.summary.failed, 1);
  assert.equal(results.summary.retries, 0);
  assert.equal(results.tests[0].pastAttempts, undefined);
  assert.equal(results.tests[0].attempt.status.message, bodyError.message);
  assert.equal(results.summary.otherErrors, 1);
  assert.equal(results.otherErrors[0].message, hookError.message);
});

test("leaves a spec without hook failures alone", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/normal.cy.js");
  const suite = addSuite(root, "no hooks");
  const passing = addTest(suite, "passes");
  const failing = addTest(suite, "fails its body");

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", passing);
  runner.emit("pass", passing);
  runner.emit("test end", passing);
  runner.emit("test", failing);
  runner.emit("fail", failing, assertionError("expected 1 to equal 2"));
  runner.emit("test end", failing);
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.successful, 1);
  assert.equal(results.summary.failed, 1);
  assert.equal(results.summary.otherErrors, 0);
  assert.deepEqual(results.otherErrors, []);
  assert.equal(statusOf(results, "no hooks passes"), "successful");
  assert.equal(statusOf(results, "no hooks fails its body"), "failed");
});

test("forgives a hook failure a retry recovered from", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/flaky-hook.cy.js");
  const suite = addSuite(root, "flaky beforeEach");
  const flaky = addTest(suite, "passes on the second attempt");
  const error = assertionError("expected 'hook' to equal 'broken'");

  // The hook failed once and then succeeded, so Cypress calls this run green.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", flaky);
  runner.emit(
    "retry",
    createHookRetry("passes on the second attempt", "before each"),
    error,
  );
  runner.emit("pass", recoveredFromHook(flaky, "before each"));
  runner.emit("test end", flaky);
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();
  const result = results.tests[0];

  assert.equal(results.summary.tests, 1);
  assert.equal(results.summary.successful, 1);
  assert.equal(results.summary.flaky, 1);
  assert.equal(results.summary.retries, 1);
  assert.equal(results.summary.otherErrors, 0);
  assert.equal(results.summary.status.kind, "successful");
  assert.deepEqual(
    [...result.pastAttempts, result.attempt].map(
      (attempt) => attempt.status.kind,
    ),
    ["failed", "successful"],
  );
  assert.equal(result.pastAttempts[0].status.message, error.message);
});

test("keeps a retried hook failure out of the test's attempts", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/retried-hook.cy.js");
  const suite = addSuite(root, "retried beforeEach");
  const first = addTest(suite, "never runs");
  const error = assertionError("expected 'hook' to equal 'broken'");

  addTest(suite, "also never runs");

  // The hook failed on all three attempts: two `retry` events and a final `fail`.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", first);
  runner.emit("retry", createHookRetry("never runs", "before each"), error);
  runner.emit("retry", createHookRetry("never runs", "before each"), error);
  runner.emit(
    "fail",
    createHookFailure(suite, "before each", "never runs", error),
    error,
  );
  runner.emit("test end", endedFromHook(first, "before each", error));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  // Recording the hook's failures as attempts made a test that never executed
  // look like one retried to exhaustion.
  assert.deepEqual(names(results), [
    "retried beforeEach also never runs",
    "retried beforeEach never runs",
  ]);
  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.skipped, 2);
  assert.equal(results.summary.failed, 0);
  assert.equal(results.summary.retries, 0);
  assert.equal(results.summary.flaky, 0);
  assert.equal(results.summary.otherErrors, 3);
  assert.equal(results.summary.status.kind, "failed");
  results.otherErrors.forEach((otherError) =>
    assert.equal(otherError.meta.hook, "before each"),
  );
});

test("numbers a retried body failure without counting its hook's", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/retried-body-and-hook.cy.js");
  const suite = addSuite(root, "both fail every attempt");
  const failing = addTest(suite, "fails its body");
  const bodyError = assertionError("expected 1 to equal 2");
  const hookError = assertionError("expected 'afterEach' to equal 'broken'");

  // Each attempt fails twice: once in the body, once in the afterEach.
  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", failing);
  [1, 2].forEach(() => {
    runner.emit("retry", createDegradedRetry("fails its body"), bodyError);
    runner.emit(
      "retry",
      createHookRetry("fails its body", "after each"),
      hookError,
    );
  });
  runner.emit("fail", failing, bodyError);
  runner.emit(
    "fail",
    createHookFailure(suite, "after each", "fails its body", hookError),
    hookError,
  );
  runner.emit("test end", endedFromHook(failing, "after each", hookError));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();
  const result = results.tests[0];
  const attempts = [...result.pastAttempts, result.attempt];

  // Counting the hook's failures as attempts pushed every body failure onto a
  // later attempt's number than the one Cypress wrote its screenshot under.
  assert.equal(results.summary.tests, 1);
  assert.equal(attempts.length, 3);
  attempts.forEach((attempt) =>
    assert.equal(attempt.status.message, bodyError.message),
  );
  assert.equal(results.summary.failed, 1);
  assert.equal(results.summary.flaky, 0);
  assert.equal(results.summary.otherErrors, 3);
});

function writeScreenshot(projectRoot, spec, baseName) {
  const file = path.join(
    projectRoot,
    "cypress/screenshots",
    spec,
    `${baseName}.png`,
  );

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "png");

  return file;
}

test("attaches the screenshot Cypress took for a hook failure", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const spec = "cypress/e2e/before-each-hook.cy.js";
  const runner = new EventEmitter();
  const root = createRootSuite(spec);
  const suite = addSuite(root, "beforeEach fails");
  const first = addTest(suite, "never runs");
  const error = assertionError("expected 'hook' to equal 'broken'");
  const screenshot = writeScreenshot(
    projectRoot,
    "before-each-hook.cy.js",
    "beforeEach fails -- never runs -- before each hook (failed)",
  );

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", first);
  runner.emit(
    "fail",
    createHookFailure(suite, "before each", "never runs", error),
    error,
  );
  runner.emit("test end", endedFromHook(first, "before each", error));
  runner.emit("end");

  const results = JSON.parse(
    fs.readFileSync(path.join(projectRoot, outputFile), "utf8"),
  );

  assert.deepEqual(results.otherErrors[0].meta, {
    hook: "before each",
    screenshot: { image: screenshot },
  });
});

test("recovers a test-named screenshot no attempt claimed", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const spec = "cypress/e2e/retried-hook.cy.js";
  const runner = new EventEmitter();
  const root = createRootSuite(spec);
  const suite = addSuite(root, "retried beforeEach");
  const first = addTest(suite, "never runs");
  const error = assertionError("expected 'hook' to equal 'broken'");
  // Cypress names the earlier attempts of a retried `before` hook after the test
  // alone, and only the last after the hook.
  const testNamed = writeScreenshot(
    projectRoot,
    "retried-hook.cy.js",
    "retried beforeEach -- never runs (failed)",
  );
  const hookNamed = writeScreenshot(
    projectRoot,
    "retried-hook.cy.js",
    "retried beforeEach -- never runs -- before each hook (failed) (attempt 2)",
  );

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", first);
  runner.emit("retry", createHookRetry("never runs", "before each"), error);
  runner.emit(
    "fail",
    createHookFailure(suite, "before each", "never runs", error),
    error,
  );
  runner.emit("test end", endedFromHook(first, "before each", error));
  runner.emit("end");

  const results = JSON.parse(
    fs.readFileSync(path.join(projectRoot, outputFile), "utf8"),
  );

  // Skipped, so it claims no image — leaving the one named after it for the hook.
  assert.equal(results.tests[0].attempt.status.kind, "skipped");
  assert.equal(results.tests[0].attempt.meta, undefined);
  assert.equal(results.otherErrors[0].meta.screenshot.image, testNamed);
  assert.equal(results.otherErrors[1].meta.screenshot.image, hookNamed);
});

test("does not give a hook failure the screenshot of a failing body", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const spec = "cypress/e2e/body-and-hook.cy.js";
  const runner = new EventEmitter();
  const root = createRootSuite(spec);
  const suite = addSuite(root, "body and hook both fail");
  const failing = addTest(suite, "fails its body");
  const bodyError = assertionError("expected 1 to equal 2");
  const hookError = assertionError("expected 'afterEach' to equal 'broken'");
  // Only the body's screenshot exists — Cypress wrote none for the hook.
  const bodyScreenshot = writeScreenshot(
    projectRoot,
    "body-and-hook.cy.js",
    "body and hook both fail -- fails its body (failed)",
  );

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", failing);
  runner.emit("fail", failing, bodyError);
  runner.emit(
    "fail",
    createHookFailure(suite, "after each", "fails its body", hookError),
    hookError,
  );
  runner.emit("test end", endedFromHook(failing, "after each", hookError));
  runner.emit("end");

  const results = JSON.parse(
    fs.readFileSync(path.join(projectRoot, outputFile), "utf8"),
  );

  // The body ran and failed, so that image is the test's, not the hook's.
  assert.equal(results.tests[0].attempt.meta.screenshot.image, bodyScreenshot);
  assert.equal(results.otherErrors[0].meta.screenshot, undefined);
  assert.equal(results.otherErrors[0].meta.hook, "after each");
});

test("keeps a blocked test that shares a title with one that ran", () => {
  const { runner, report } = createReporter();
  const root = createRootSuite("cypress/e2e/duplicate-blocked.cy.js");
  const suite = addSuite(root, "duplicate blocked");
  const first = addTest(suite, "shares a title");
  const second = addTest(suite, "shares a title");
  const error = assertionError("expected 'hook' to equal 'broken'");

  runner.emit("suite", root);
  runner.emit("suite", suite);
  runner.emit("test", first);
  runner.emit("pass", first);
  runner.emit("test end", first);
  runner.emit("test", second);
  runner.emit(
    "fail",
    createHookFailure(suite, "before each", "shares a title", error),
    error,
  );
  runner.emit("test end", endedFromHook(second, "before each", error));
  runner.emit("suite end", suite);
  runner.emit("suite end", root);
  runner.emit("end");

  const results = report();

  // Both declarations share a key, so matching them to reported records by
  // presence rather than by count loses the one the hook blocked.
  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.successful, 1);
  assert.equal(results.summary.skipped, 1);
  assert.deepEqual(
    results.tests.map((result) => result.attempt.status.kind),
    ["successful", "skipped"],
  );
});
