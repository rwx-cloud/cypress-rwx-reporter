const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const RwxReporter = require("../index");

const LOG_PREFIX = "[@rwx-cloud/cypress-rwx-reporter]";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cypress-rwx-reporter-"));
}

// Passes every non-reporter write through: the test runner's own output goes
// through `process.stdout.write` too, and swallowing it loses test results.
function captureWarnings(t) {
  const warnings = [];
  const write = process.stdout.write.bind(process.stdout);

  t.mock.method(process.stdout, "write", (chunk, ...rest) => {
    if (typeof chunk === "string" && chunk.startsWith(LOG_PREFIX)) {
      warnings.push(chunk);

      return true;
    }

    return write(chunk, ...rest);
  });

  return warnings;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createMochaTest(attributes) {
  const titlePath = attributes.titlePath || [attributes.title];

  return {
    title: titlePath[titlePath.length - 1],
    file: attributes.file,
    duration: attributes.duration,
    consoleOutputs: attributes.consoleOutputs,
    consoleErrors: attributes.consoleErrors,
    state: undefined,
    _currentRetry: 0,
    currentRetry() {
      return this._currentRetry;
    },
    titlePath() {
      return titlePath;
    },
    fullTitle() {
      return titlePath.join(" ");
    },
  };
}

// Only `title` survives on Cypress's `retry` event — cypress-io/cypress#27732.
function createDegradedRetryTest({ title }) {
  return {
    title,
    titlePath() {
      return null;
    },
    fullTitle() {
      return null;
    },
  };
}

// Verified against cypress@15.18.0: one `test` covers every attempt.
function emitFlakyRetry(runner, flaky) {
  runner.emit("test", flaky);
  runner.emit(
    "retry",
    createDegradedRetryTest({ title: flaky.title }),
    new Error("first failure"),
  );
  runner.emit("pass", flaky);
  runner.emit("test end", flaky);
}

test("writes RWX results for passing, failing, and skipped tests", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const passing = createMochaTest({
    titlePath: ["todos", "loads"],
    file: "cypress/e2e/todos.cy.js",
    duration: 12,
  });
  const failing = createMochaTest({
    titlePath: ["todos", "saves"],
    file: "cypress/e2e/todos.cy.js",
    duration: 34,
  });
  const skipped = createMochaTest({
    titlePath: ["todos", "deletes"],
    file: "cypress/e2e/todos.cy.js",
  });

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  runner.emit("test", passing);
  runner.emit("pass", passing);
  runner.emit("test", failing);
  runner.emit("fail", failing, new TypeError("boom"));
  runner.emit("pending", skipped);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  // Captain selects its parser off this URL, so a typo here silently costs us
  // every downstream consumer.
  assert.equal(
    results.$schema,
    "https://raw.githubusercontent.com/rwx-research/test-results-schema/main/v1.json",
  );
  assert.deepEqual(results.framework, {
    language: "JavaScript",
    kind: "Cypress",
  });
  assert.equal(results.summary.tests, 3);
  assert.equal(results.summary.successful, 1);
  assert.equal(results.summary.failed, 1);
  assert.equal(results.summary.skipped, 1);
  assert.equal(results.summary.status.kind, "failed");
  assert.equal(results.tests[0].name, "todos loads");
  assert.equal(results.tests[0].attempt.durationInNanoseconds, 12000000);
  assert.equal(results.tests[1].attempt.status.exception, "TypeError");
  assert.equal(results.tests[1].location.file, "cypress/e2e/todos.cy.js");
});

test("records retry attempts as pastAttempts", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const flaky = createMochaTest({
    titlePath: ["checkout", "submits"],
    file: "cypress/e2e/checkout.cy.js",
    duration: 20,
  });

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  emitFlakyRetry(runner, flaky);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const result = results.tests[0];

  assert.equal(result.attempt.status.kind, "successful");
  assert.equal(result.pastAttempts.length, 1);
  assert.equal(result.pastAttempts[0].status.kind, "failed");
  assert.equal(result.pastAttempts[0].status.message, "first failure");
  assert.equal(results.summary.retries, 1);
  assert.equal(results.summary.flaky, 1);
  assert.equal(results.summary.status.kind, "successful");
});

test("merges Cypress retry events that omit suite and file data", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const flaky = createMochaTest({
    titlePath: ["checkout", "submits"],
    file: "cypress/e2e/checkout.cy.js",
    duration: 20,
  });

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  emitFlakyRetry(runner, flaky);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  // The degraded `retry` event carries no suite and no file, so on its own it
  // would name a test the spec never declared.
  assert.equal(results.summary.tests, 1);
  assert.equal(results.tests[0].name, "checkout submits");
  assert.deepEqual(results.tests[0].lineage, ["checkout", "submits"]);
  assert.equal(results.tests[0].location.file, "cypress/e2e/checkout.cy.js");
  assert.equal(results.tests[0].pastAttempts.length, 1);
});

test("finds Cypress screenshots when Cypress stores them under the spec basename", () => {
  const projectRoot = tmpdir();
  const screenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/fail-twice.cy.js/fail twice (failed).png",
  );
  const failing = createMochaTest({
    titlePath: ["fail twice"],
    file: "cypress/e2e/fail-twice.cy.js",
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 1, {}, projectRoot),
    screenshotPath,
  );
});

test("finds Cypress screenshots truncated with Cypress's filename limit", () => {
  const projectRoot = tmpdir();
  const longTitle = "a".repeat(300);
  const screenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/long.cy.js",
    `${"a".repeat(250)}.png`,
  );
  const failing = createMochaTest({
    titlePath: [longTitle],
    file: "cypress/e2e/long.cy.js",
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 1, {}, projectRoot),
    screenshotPath,
  );
});

test("prefers Cypress collision filenames for truncated retry screenshots", () => {
  const projectRoot = tmpdir();
  const longTitle = "a".repeat(300);
  const firstScreenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/long.cy.js",
    `${"a".repeat(250)}.png`,
  );
  const retryScreenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/long.cy.js",
    `${"a".repeat(246)} (1).png`,
  );
  const failing = createMochaTest({
    titlePath: [longTitle],
    file: "cypress/e2e/long.cy.js",
  });

  fs.mkdirSync(path.dirname(firstScreenshotPath), { recursive: true });
  fs.writeFileSync(firstScreenshotPath, "png");
  fs.writeFileSync(retryScreenshotPath, "png");

  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 2, {}, projectRoot),
    retryScreenshotPath,
  );
});

// A previous Cypress invocation's screenshot is seconds old at least by the time
// a Captain retry writes its own, so a gap this size is well past anything the
// tolerance for clock skew would forgive.
function backdate(file, secondsAgo = 60) {
  const when = new Date(Date.now() - secondsAgo * 1000);

  fs.utimesSync(file, when, when);
}

test("keeps truncated attempt 1 off the retry's screenshot", () => {
  const projectRoot = tmpdir();
  const longTitle = "a".repeat(300);
  const firstScreenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/long.cy.js",
    `${"a".repeat(250)}.png`,
  );
  const retryScreenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/long.cy.js",
    `${"a".repeat(246)} (1).png`,
  );
  const failing = createMochaTest({
    titlePath: [longTitle],
    file: "cypress/e2e/long.cy.js",
  });

  fs.mkdirSync(path.dirname(firstScreenshotPath), { recursive: true });
  fs.writeFileSync(firstScreenshotPath, "png");
  fs.writeFileSync(retryScreenshotPath, "png");
  // Both belong to this invocation, and the retry's is the newer of the two.
  backdate(firstScreenshotPath, 2);

  // The mirror of the test above, and the reason screenshots are discovered by
  // filtering on modification time rather than ranking by it: ranking would give
  // attempt 1 the retry's image, because within one invocation "newest" only
  // ever means "the last attempt". The name is what tells these two apart.
  assert.equal(
    RwxReporter.findFailureScreenshot(
      failing,
      1,
      {},
      projectRoot,
      new Date(Date.now() - 10000),
    ),
    firstScreenshotPath,
  );
});


test("skips a screenshot a previous invocation left under the un-suffixed name", () => {
  const projectRoot = tmpdir();
  const directory = path.join(projectRoot, "cypress/screenshots/notrash.cy.js");
  const previous = path.join(directory, "notrash -- fails (failed).png");
  const current = path.join(directory, "notrash -- fails (failed) (1).png");
  const failing = createMochaTest({
    titlePath: ["notrash", "fails"],
    file: "cypress/e2e/notrash.cy.js",
  });

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(previous, "png");
  fs.writeFileSync(current, "png");
  backdate(previous);

  // With `trashAssetsBeforeRuns` off the un-suffixed name is the previous
  // invocation's, and this invocation's attempt 1 is the collision-suffixed one.
  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 1, {}, projectRoot, Date.now()),
    current,
  );
  // Told nothing about when the invocation started, there is nothing to tell the
  // two apart.
  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 1, {}, projectRoot),
    previous,
  );
});

test("finds this invocation's screenshot past several previous invocations", () => {
  const projectRoot = tmpdir();
  const directory = path.join(projectRoot, "cypress/screenshots/notrash.cy.js");
  const baseName = "notrash -- fails (failed)";
  const failing = createMochaTest({
    titlePath: ["notrash", "fails"],
    file: "cypress/e2e/notrash.cy.js",
  });

  fs.mkdirSync(directory, { recursive: true });
  [`${baseName}.png`, `${baseName} (1).png`, `${baseName} (2).png`].forEach(
    (filename, index) => {
      const file = path.join(directory, filename);

      fs.writeFileSync(file, "png");

      // Only the third invocation's is left current.
      if (index < 2) {
        backdate(file, 60 * (2 - index));
      }
    },
  );

  // Which collision number Cypress reached depends on how many invocations came
  // before, so the number itself carries no information about whose it is.
  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 1, {}, projectRoot, Date.now()),
    path.join(directory, `${baseName} (2).png`),
  );
});

test("falls back to every screenshot when none looks like this invocation's", () => {
  const projectRoot = tmpdir();
  const directory = path.join(projectRoot, "cypress/screenshots/stale.cy.js");
  const screenshotPath = path.join(directory, "stale -- fails (failed).png");
  const failing = createMochaTest({
    titlePath: ["stale", "fails"],
    file: "cypress/e2e/stale.cy.js",
  });

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(screenshotPath, "png");
  backdate(screenshotPath);

  // A filesystem whose timestamps cannot be trusted should cost the attempt
  // nothing more than the discrimination — never the screenshot itself.
  assert.equal(
    RwxReporter.findFailureScreenshot(failing, 1, {}, projectRoot, Date.now()),
    screenshotPath,
  );
});

test("attaches the current invocation's screenshot, not a previous one's", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const directory = path.join(projectRoot, "cypress/screenshots/notrash.cy.js");
  const previous = path.join(directory, "notrash -- fails (failed).png");
  const current = path.join(directory, "notrash -- fails (failed) (1).png");
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["notrash", "fails"],
    file: "cypress/e2e/notrash.cy.js",
  });

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(previous, "png");
  backdate(previous);

  // Constructed with only the previous invocation's screenshot on disk, which is
  // where a Captain retry's Cypress process starts from.
  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  fs.writeFileSync(current, "png");

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("fails again"));
  runner.emit("test end", failing);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  assert.deepEqual(results.tests[0].attempt.meta, {
    screenshot: { image: current },
  });
});

test("attaches failure screenshots to the matching attempt", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/cypress/e2e/fail-twice.cy.js/fail twice (failed) (attempt 2).png",
  );
  const runner = new EventEmitter();
  const retried = createMochaTest({
    titlePath: ["fail twice"],
    file: "cypress/e2e/fail-twice.cy.js",
    duration: 20,
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  runner.emit("test", retried);
  runner.emit(
    "retry",
    createDegradedRetryTest({ title: retried.title }),
    new Error("first failure"),
  );
  runner.emit("fail", retried, new Error("second failure"));
  runner.emit("test end", retried);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const finalAttempt = results.tests[0].attempt;

  assert.equal(results.tests[0].pastAttempts[0].meta, undefined);
  assert.deepEqual(finalAttempt.meta, {
    screenshot: { image: screenshotPath },
  });
});

function hookFixture(name) {
  return path.join(__dirname, "fixtures", name);
}

function screenshotPathFor(projectRoot, spec, baseName) {
  return path.join(projectRoot, "cypress/screenshots", spec, `${baseName}.png`);
}

test("invokes the hook for retry, pass, fail, and pending attempts", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const retried = createMochaTest({
    titlePath: ["retried"],
    file: "cypress/e2e/hook.cy.js",
  });
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });
  const pending = createMochaTest({
    titlePath: ["pending"],
    file: "cypress/e2e/hook.cy.js",
  });

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  emitFlakyRetry(runner, retried);
  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("test end", failing);
  // Cypress reports a skipped test before it would have started it.
  runner.emit("pending", pending);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const byName = Object.fromEntries(
    results.tests.map((result) => [result.name, result]),
  );
  const hookHtml = (attempt) =>
    path.basename(attempt.meta.screenshot.html, ".html");

  assert.equal(
    hookHtml(byName.retried.pastAttempts[0]),
    "hook-failed-1-error-no-screenshot",
  );
  assert.equal(
    hookHtml(byName.retried.attempt),
    "hook-successful-2-no-error-no-screenshot",
  );
  assert.equal(
    hookHtml(byName.failing.attempt),
    "hook-failed-1-error-no-screenshot",
  );
  assert.equal(
    hookHtml(byName.pending.attempt),
    "hook-skipped-1-no-error-no-screenshot",
  );
});

test("resolves a hook path relative to the project root", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const passing = createMochaTest({
    titlePath: ["passes"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.mkdirSync(path.join(projectRoot, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "artifacts/report.html"), "<html>");
  fs.writeFileSync(
    path.join(projectRoot, "hooks/attachments.js"),
    'module.exports = () => ({ screenshot: { html: "artifacts/report.html" } });\n',
  );

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: "hooks/attachments.js",
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", passing);
  runner.emit("pass", passing);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  assert.deepEqual(results.tests[0].attempt.meta.screenshot, {
    html: path.join(projectRoot, "artifacts/report.html"),
  });
});

test("contains a hook that throws", (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/hook.cy.js",
    "failing (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });
  const passing = createMochaTest({
    titlePath: ["passing"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");
  const warnings = captureWarnings(t);

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-throwing.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("test", passing);
  runner.emit("pass", passing);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const byName = Object.fromEntries(
    results.tests.map((result) => [result.name, result]),
  );

  // The fixture reads error.message, so it succeeds on the failure and throws
  // on the pass. The run completes either way and the reporter's own work
  // survives on both attempts.
  assert.equal(results.tests.length, 2);
  assert.equal(byName.failing.attempt.meta.screenshot.image, screenshotPath);
  assert.equal(byName.passing.attempt.meta, undefined);
  assert.equal(
    warnings.filter((warning) => /attachmentsHook threw/.test(warning)).length,
    1,
  );
});

test("stops a hook from mutating the test object", (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["todos", "saves"],
    file: "cypress/e2e/hook.cy.js",
  });

  const warnings = captureWarnings(t);

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-mutating.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  // The write throws, so the hook is contained and contributes nothing, and
  // the reporter's view of the test is untouched.
  assert.equal(failing.title, "saves");
  assert.equal(results.tests[0].name, "todos saves");
  assert.deepEqual(results.tests[0].lineage, ["todos", "saves"]);
  assert.equal(results.tests[0].attempt.meta, undefined);
  assert.equal(
    warnings.filter((warning) => /may not modify "title"/.test(warning)).length,
    1,
  );
});

test("keeps the discovered screenshot alongside hook attachments", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/hook.cy.js",
    "failing (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  assert.deepEqual(attempt.meta.screenshot, {
    image: screenshotPath,
    html: path.join(
      projectRoot,
      "artifacts/hook-failed-1-error-screenshot.html",
    ),
  });
});

test("invokes the hook when screenshot discovery is disabled", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/hook.cy.js",
    "failing (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  assert.equal(
    attempt.meta.screenshot.html,
    path.join(projectRoot, "artifacts/hook-failed-1-error-no-screenshot.html"),
  );
  assert.equal(attempt.meta.screenshot.image, undefined);
});

test("attaches screenshots Cypress finishes writing after the failure event", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/late.cy.js",
    "late (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["late"],
    file: "cypress/e2e/late.cy.js",
  });

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));

  // Cypress finishes writing the screenshot only after the failure event.
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  runner.emit("end");

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  assert.deepEqual(attempt.meta, { screenshot: { image: screenshotPath } });
});

test("appends a late screenshot to attachments a hook already supplied", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/late.cy.js",
    "late (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["late"],
    file: "cypress/e2e/late.cy.js",
  });

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  runner.emit("end");

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  // The hook only supplied an HTML snapshot, so the back-fill must still run
  // and must merge rather than replace.
  assert.deepEqual(attempt.meta.screenshot, {
    html: path.join(
      projectRoot,
      "artifacts/hook-failed-1-error-no-screenshot.html",
    ),
    image: screenshotPath,
  });
});

test("uses hash output filenames", () => {
  const projectRoot = tmpdir();
  const runner = new EventEmitter();
  const passing = createMochaTest({
    titlePath: ["todos", "loads"],
    file: "cypress/e2e/todos.cy.js",
    duration: 12,
  });

  new RwxReporter(runner, {
    reporterOptions: { outputFile: "results/results-[hash].json", projectRoot },
  });

  runner.emit("test", passing);
  runner.emit("pass", passing);
  runner.emit("end");

  const entries = fs.readdirSync(path.join(projectRoot, "results"));

  assert.equal(entries.length, 1);
  assert.match(entries[0], /^results-[a-f0-9]{32}\.json$/);
});

test("infers project root from Cypress config", () => {
  const projectRoot = tmpdir();

  assert.equal(
    RwxReporter.getProjectRoot({}, { config: { projectRoot } }),
    projectRoot,
  );
});

test("lets reporter options override inferred project root", () => {
  const projectRoot = tmpdir();
  const overrideRoot = tmpdir();

  assert.equal(
    RwxReporter.getProjectRoot(
      { projectRoot: overrideRoot },
      { config: { projectRoot } },
    ),
    overrideRoot,
  );
});

test("handles string reporter options from the Cypress CLI", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = path.join(
    projectRoot,
    "cypress/screenshots/cypress/e2e/todos.cy.js/todos -- saves (failed).png",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["todos", "saves"],
    file: "cypress/e2e/todos.cy.js",
    duration: 34,
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: "false" },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(results.tests[0].attempt.meta, undefined);
});

test("prefers a hook screenshot over the one the reporter discovered", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/hook.cy.js",
    "failing (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-image.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  assert.deepEqual(attempt.meta.screenshot, {
    image: path.join(projectRoot, "artifacts/hook-shot.png"),
  });
});

test("does not let the end-of-run back-fill replace a hook screenshot", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/late.cy.js",
    "late (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["late"],
    file: "cypress/e2e/late.cy.js",
  });

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-image.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));

  // Cypress writes its screenshot only after the failure event.
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  runner.emit("end");

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  assert.deepEqual(attempt.meta.screenshot, {
    image: path.join(projectRoot, "artifacts/hook-shot.png"),
  });
});

function createRetryProbe() {
  return createMochaTest({
    titlePath: ["retry probe", "always fails"],
    file: "cypress/e2e/retries-on.cy.js",
  });
}

function attemptsOf(result) {
  return [...(result.pastAttempts || []), result.attempt];
}

// The three failure events Cypress emits for a test retried twice and failing
// every time: the middle two degraded, the last one whole.
function emitRetriedFailure(runner, failing) {
  const degraded = () => createDegradedRetryTest({ title: failing.title });

  runner.emit("test", failing);
  runner.emit("retry", degraded(), new Error("first failure"));
  runner.emit("retry", degraded(), new Error("second failure"));
  runner.emit("fail", failing, new Error("third failure"));
  runner.emit("test end", failing);
}

test("merges every degraded retry event of a test that fails each attempt", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  emitRetriedFailure(runner, failing);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const result = results.tests[0];

  // Cypress ran one failing test three times. Every attempt belongs to it, so
  // there is no second record, and the counts describe the spec as written.
  assert.equal(results.tests.length, 1);
  assert.equal(results.summary.tests, 1);
  assert.equal(results.summary.failed, 1);
  assert.equal(results.summary.retries, 1);
  assert.equal(result.name, "retry probe always fails");
  assert.deepEqual(result.lineage, ["retry probe", "always fails"]);
  assert.equal(result.location.file, "cypress/e2e/retries-on.cy.js");
  assert.equal(result.pastAttempts.length, 2);
  assert.deepEqual(
    attemptsOf(result).map((attempt) => attempt.status.message),
    ["first failure", "second failure", "third failure"],
  );
});

test("numbers the attempts of a retried failure the way Cypress names its screenshots", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const spec = "retries-on.cy.js";
  const baseName = "retry probe -- always fails (failed)";
  const runner = new EventEmitter();
  const failing = createRetryProbe();

  ["", " (attempt 2)", " (attempt 3)"].forEach((suffix) => {
    const screenshotPath = screenshotPathFor(
      projectRoot,
      spec,
      `${baseName}${suffix}`,
    );

    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, "png");
  });

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot } });

  emitRetriedFailure(runner, failing);
  runner.emit("end");

  const result = readJson(path.join(projectRoot, outputFile)).tests[0];

  // Cypress writes one screenshot per attempt and numbers them from its own
  // retry counter. Dropping an attempt used to shift every later attempt onto
  // the previous attempt's image, with nothing to signal the mismatch.
  assert.deepEqual(
    attemptsOf(result).map((attempt) =>
      path.basename(attempt.meta.screenshot.image),
    ),
    [
      `${baseName}.png`,
      `${baseName} (attempt 2).png`,
      `${baseName} (attempt 3).png`,
    ],
  );
});

test("starts each retried attempt where the previous one finished", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();
  const reporter = new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });
  let tick = 0;

  reporter.now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1)));

  emitRetriedFailure(runner, failing);
  runner.emit("end");

  const result = readJson(path.join(projectRoot, outputFile)).tests[0];
  const attempts = attemptsOf(result);

  // Cypress emits no second `test` event for a retry, so without carrying the
  // clock forward every attempt after the first serialized with no `startedAt`.
  attempts.forEach((attempt, index) => {
    assert.ok(attempt.startedAt, `attempt ${index + 1} has no startedAt`);

    if (index > 0) {
      assert.equal(attempt.startedAt, attempts[index - 1].finishedAt);
    }
  });
});

test("keeps a degraded event for another test out of the test in flight", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit(
    "retry",
    createDegradedRetryTest({ title: "a different test", currentRetry: 0 }),
    new Error("elsewhere"),
  );
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  // Only a title match earns the merge. An event we can't place stays its own
  // record rather than inventing an extra attempt on an unrelated test, and it
  // still carries the spec so consumers can locate it.
  assert.deepEqual(
    results.tests.map((result) => result.name),
    ["retry probe always fails", "a different test"],
  );
  assert.equal(results.tests[0].pastAttempts, undefined);
  assert.equal(results.tests[1].location.file, "cypress/e2e/retries-on.cy.js");
});

function finish(reporter, failures = 0) {
  return new Promise((resolve) => reporter.done(failures, resolve));
}


// A clock the caller advances, so an attempt's recorded window is what the test
// says it is rather than however long the emits took.
function fakeClock(reporter) {
  let elapsed = 0;

  reporter.now = () => new Date(Date.UTC(2026, 0, 1) + elapsed);

  return { advance: (milliseconds) => (elapsed += milliseconds) };
}

// What cypress@15.18.0 does to the one live test object between attempts: it
// writes an attempt's outcome only after emitting the event, so at every event
// the live test still describes the previous attempt while the event's own object
// has this attempt's state, error, and duration. The retry counter is already
// right on the live test.
//
// The last attempt of a test that ends in failure is the exception: Cypress
// reports it with an object that has not caught up either, and the duration only
// appears — on the live test — by `test end`.
//
// `durations` are what Cypress reports each attempt cost; `windows` how long the
// reporter's own clock says each attempt was in flight, which is longer.
function emitLiveRetriedFailure(runner, failing, options = {}) {
  const durations = options.durations || [87, 91, 95];
  const windows = options.windows || [];
  const elapse = (index) => options.clock?.advance(windows[index] || 0);
  const retryEvent = (state, err, duration) => ({
    ...createDegradedRetryTest({ title: failing.title }),
    currentRetry: 2,
    duration,
    err,
    state,
  });
  const firstFailure = new Error("first failure");
  const secondFailure = new Error("second failure");
  const thirdFailure = new Error("third failure");

  failing.state = "skipped";

  runner.emit("test", failing);
  elapse(0);
  runner.emit(
    "retry",
    retryEvent("failed", firstFailure, durations[0]),
    firstFailure,
  );

  // Caught up to attempt 1, no further.
  failing._currentRetry = 1;
  failing.state = "failed";
  failing.duration = durations[0];
  elapse(1);
  runner.emit(
    "retry",
    retryEvent("failed", secondFailure, durations[1]),
    secondFailure,
  );

  // Caught up to attempt 2, no further.
  failing._currentRetry = 2;
  failing.duration = durations[1];
  failing.err = thirdFailure;
  elapse(2);
  // Whole rather than degraded, but still carrying attempt 2's duration.
  runner.emit("fail", { ...failing }, thirdFailure);

  // Only now does the last attempt's duration exist anywhere.
  failing.duration = durations[2];
  runner.emit("test end", failing);
}

test("gives every attempt its own duration, not the previous attempt's", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();
  const reporter = new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  // Attempts costing deliberately different times, so a duration belonging to
  // the previous attempt cannot pass for this one's.
  emitLiveRetriedFailure(runner, failing, {
    clock: fakeClock(reporter),
    durations: [1500, 500, 100],
    windows: [1515, 528, 128],
  });
  runner.emit("end");

  const result = readJson(path.join(projectRoot, outputFile)).tests[0];
  const attempts = attemptsOf(result);
  const millis = (attempt) => attempt.durationInNanoseconds / 1000000;
  const window = (attempt) =>
    Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);

  // Cypress reports each attempt through a per-attempt object and only afterwards
  // copies that attempt's outcome onto the long-lived test, so reading the
  // long-lived one reported attempt 2 as having taken attempt 1's 1500ms, and
  // attempt 3 as having taken attempt 2's 500ms.
  assert.deepEqual(attempts.map(millis), [1500, 500, 100]);

  // And the record must not contradict itself: no attempt can have taken longer
  // than the window between its own timestamps.
  attempts.forEach((attempt, index) =>
    assert.ok(
      millis(attempt) <= window(attempt),
      `attempt ${index + 1} recorded ${millis(attempt)}ms inside a ${window(attempt)}ms window`,
    ),
  );
});

test("settles a duration onto the test that ended, not the one in flight", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();
  const elsewhere = createMochaTest({
    titlePath: ["retry probe", "another test"],
    file: "cypress/e2e/retries-on.cy.js",
    duration: 9999,
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });
  const clock = fakeClock(reporter);

  runner.emit("test", failing);
  clock.advance(40);
  runner.emit("fail", failing, new Error("boom"));
  // The settle reads the ending test's own duration, so an event for a test
  // that is not the one in flight must not reach the attempt just recorded.
  runner.emit("test end", elsewhere);

  runner.emit("end");

  const result = readJson(path.join(projectRoot, outputFile)).tests[0];

  assert.equal(result.name, "retry probe always fails");
  assert.equal(result.attempt.durationInNanoseconds, 40000000);
});

test("falls back to its own clock for an attempt Cypress gave no duration", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();
  const reporter = new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });
  const clock = fakeClock(reporter);

  // The degraded `retry` event carries no duration, and neither does the live
  // test until Cypress writes the first attempt's outcome onto it.
  runner.emit("test", failing);
  clock.advance(40);
  runner.emit(
    "retry",
    createDegradedRetryTest({ title: failing.title }),
    new Error("first failure"),
  );
  clock.advance(60);
  runner.emit("fail", failing, new Error("second failure"));
  runner.emit("test end", failing);
  runner.emit("end");

  const result = readJson(path.join(projectRoot, outputFile)).tests[0];

  assert.deepEqual(
    attemptsOf(result).map((attempt) => attempt.durationInNanoseconds),
    [40000000, 60000000],
  );
});

test("waits for an async hook and hands it the attempt it was invoked for", async () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-async-state.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  emitLiveRetriedFailure(runner, failing);
  runner.emit("end");

  assert.equal(
    fs.existsSync(path.join(projectRoot, outputFile)),
    false,
    "results were written before the hook finished",
  );

  await finish(reporter, 1);

  const result = readJson(path.join(projectRoot, outputFile)).tests[0];

  // Each attempt reports its own counter and error rather than the last attempt's.
  assert.deepEqual(
    attemptsOf(result).map((attempt) =>
      path.basename(attempt.meta.screenshot.html, ".html"),
    ),
    [
      "failed-1-0-failed-retry-probe-always-fails-first-failure",
      "failed-2-1-failed-retry-probe-always-fails-second-failure",
      "failed-3-2-failed-retry-probe-always-fails-third-failure",
    ],
  );
});

test("gives a passing attempt no error, even a stale one", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const hook = path.join(projectRoot, "hook.js");
  const seen = path.join(projectRoot, "seen.jsonl");
  const runner = new EventEmitter();
  const flaky = createMochaTest({
    titlePath: ["flaky"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.writeFileSync(
    hook,
    `module.exports = (test, kind, error) =>
  require("node:fs").appendFileSync(
    ${JSON.stringify(seen)},
    JSON.stringify({
      kind,
      error: error ? error.message : null,
      testErr: test.err ? test.err.message : null,
    }) + "\\n",
  );\n`,
    "utf8",
  );

  new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hook,
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", flaky);
  // Cypress leaves the failed attempt's error on the live test.
  flaky.err = new Error("stale failure from an earlier attempt");
  runner.emit("pass", flaky);
  runner.emit("end");

  const recorded = JSON.parse(fs.readFileSync(seen, "utf8").trim());
  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(recorded.kind, "successful");
  assert.equal(recorded.error, null);
  assert.equal(results.tests[0].attempt.status.kind, "successful");
  assert.equal(results.tests[0].attempt.status.message, undefined);
});

// A test the spec declared but Cypress never ran has no event of its own, so the
// reporter synthesises a skipped attempt from the spec graph.
function createDeclaredSpec(file) {
  const root = {
    type: "suite",
    title: "",
    file,
    root: true,
    suites: [],
    tests: [],
    titlePath: () => [],
    fullTitle: () => "",
  };

  return root;
}

test("waits for an async hook on a test the spec declared but never ran", async () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const hook = path.join(projectRoot, "hook.js");
  const runner = new EventEmitter();
  const root = createDeclaredSpec("cypress/e2e/hook.cy.js");
  const ran = createMochaTest({
    titlePath: ["ran"],
    file: "cypress/e2e/hook.cy.js",
  });
  const neverRan = createMochaTest({
    titlePath: ["never ran"],
    file: "cypress/e2e/hook.cy.js",
  });

  root.tests.push(ran, neverRan);
  fs.mkdirSync(path.join(projectRoot, "artifacts"), { recursive: true });
  fs.writeFileSync(
    hook,
    `const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = async function attachments(test, kind, error, context) {
  await new Promise((resolve) => setTimeout(resolve, 5));

  const file = path.join(context.projectRoot, "artifacts", kind + ".html");

  await fs.writeFile(file, "<html>", "utf8");

  return { screenshot: { html: file } };
};\n`,
    "utf8",
  );

  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hook,
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  runner.emit("suite", root);
  runner.emit("test", ran);
  runner.emit("pass", ran);
  runner.emit("test end", ran);
  runner.emit("end");

  await finish(reporter);

  const byName = Object.fromEntries(
    readJson(path.join(projectRoot, outputFile)).tests.map((result) => [
      result.name,
      result,
    ]),
  );

  assert.equal(byName["never ran"].attempt.status.kind, "skipped");
  assert.equal(
    path.basename(byName["never ran"].attempt.meta.screenshot.html),
    "skipped.html",
  );
  assert.equal(
    path.basename(byName.ran.attempt.meta.screenshot.html),
    "successful.html",
  );
});

// Screenshot discovery and the end-of-run back-fill sit either side of the hook's
// merge, which the async path moves to after the last event.
test("keeps discovery and the late back-fill around an async hook", async () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const screenshotPath = screenshotPathFor(
    projectRoot,
    "cypress/e2e/late.cy.js",
    "late (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["late"],
    file: "cypress/e2e/late.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-async-html.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));

  // Cypress writes its screenshot only after the failure event.
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png");

  runner.emit("end");

  await finish(reporter, 1);

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  // Only HTML, so the back-fill still has to merge rather than replace.
  assert.deepEqual(attempt.meta.screenshot, {
    html: path.join(projectRoot, "artifacts/async-hook.html"),
    image: screenshotPath,
  });
});

test("lets an async hook's screenshot beat discovery and the back-fill", async () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const discovered = screenshotPathFor(
    projectRoot,
    "cypress/e2e/hook.cy.js",
    "failing (failed)",
  );
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });

  // Discovered before the event, so the hook's has to win and the back-fill has
  // to leave it alone.
  fs.mkdirSync(path.dirname(discovered), { recursive: true });
  fs.writeFileSync(discovered, "png");

  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-async-image.js"),
      outputFile,
      projectRoot,
    },
  });

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  const attempt = readJson(path.join(projectRoot, outputFile)).tests[0].attempt;

  assert.deepEqual(attempt.meta.screenshot, {
    image: path.join(projectRoot, "artifacts/async-hook.png"),
  });
});

test("refuses a mutation an async hook attempts after awaiting", async (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["todos", "saves"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-async-mutating.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  const results = readJson(path.join(projectRoot, outputFile));

  // The refusal arrives as a rejection rather than a throw.
  assert.equal(failing.title, "saves");
  assert.equal(results.tests[0].name, "todos saves");
  assert.equal(results.tests[0].attempt.meta, undefined);
  assert.equal(
    warnings.filter(
      (warning) =>
        /attachmentsHook rejected/.test(warning) &&
        /may not modify "title"/.test(warning),
    ).length,
    1,
  );
});

test("refuses a read an async hook attempts after awaiting", async (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["todos", "saves"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-async-expired.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  const results = readJson(path.join(projectRoot, outputFile));

  // Only the attachment is lost.
  assert.equal(results.tests[0].name, "todos saves");
  assert.equal(results.tests[0].attempt.status.kind, "failed");
  assert.equal(results.tests[0].attempt.meta, undefined);
  assert.equal(
    warnings.filter(
      (warning) =>
        /attachmentsHook rejected/.test(warning) &&
        /read "state" from the test object after awaiting/.test(warning) &&
        /before your first await/.test(warning),
    ).length,
    1,
    `expected a warning naming the contract, got ${JSON.stringify(warnings)}`,
  );
});

test("validates what an async hook resolves to", async (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const hook = path.join(projectRoot, "hook.js");
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.writeFileSync(
    hook,
    'module.exports = async () => "artifacts/report.html";\n',
    "utf8",
  );

  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hook,
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  assert.equal(
    readJson(path.join(projectRoot, outputFile)).tests[0].attempt.meta,
    undefined,
  );
  assert.equal(
    warnings.filter((warning) => /returned a string/.test(warning)).length,
    1,
  );
});

test("invokes an async hook for retry, pass, fail, and pending attempts", async () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const hook = path.join(projectRoot, "hook.js");
  const runner = new EventEmitter();
  const retried = createMochaTest({
    titlePath: ["retried"],
    file: "cypress/e2e/hook.cy.js",
  });
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });
  const pending = createMochaTest({
    titlePath: ["pending"],
    file: "cypress/e2e/hook.cy.js",
  });

  fs.mkdirSync(path.join(projectRoot, "artifacts"), { recursive: true });
  fs.writeFileSync(
    hook,
    `const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = async function attachments(test, kind, error, context) {
  await new Promise((resolve) => setTimeout(resolve, 5));

  const name = [kind, context.attemptNumber].join("-");
  const file = path.join(context.projectRoot, "artifacts", name + ".html");

  await fs.writeFile(file, "<html>", "utf8");

  return { screenshot: { html: file } };
};\n`,
    "utf8",
  );

  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hook,
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });

  emitFlakyRetry(runner, retried);
  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("test end", failing);
  // Cypress reports a skipped test before it would have started it.
  runner.emit("pending", pending);
  runner.emit("end");

  await finish(reporter, 1);

  const byName = Object.fromEntries(
    readJson(path.join(projectRoot, outputFile)).tests.map((result) => [
      result.name,
      result,
    ]),
  );
  const hookHtml = (attempt) =>
    path.basename(attempt.meta.screenshot.html, ".html");

  assert.equal(hookHtml(byName.retried.pastAttempts[0]), "failed-1");
  assert.equal(hookHtml(byName.retried.attempt), "successful-2");
  assert.equal(hookHtml(byName.failing.attempt), "failed-1");
  assert.equal(hookHtml(byName.pending.attempt), "skipped-1");
});

test("writes the results inline when the hook is synchronous", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const passing = createMochaTest({
    titlePath: ["passes"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  let calledBack = false;

  runner.emit("test", passing);
  runner.emit("pass", passing);
  runner.emit("end");

  assert.ok(fs.existsSync(path.join(projectRoot, outputFile)));

  reporter.done(0, () => {
    calledBack = true;
  });

  assert.equal(calledBack, true, "done deferred with nothing to wait for");
});

test("contains an async hook that rejects", async (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-rejecting.js"),
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(results.tests.length, 1);
  assert.equal(results.tests[0].attempt.status.message, "boom");
  assert.equal(results.tests[0].attempt.meta, undefined);
  assert.equal(
    warnings.filter((warning) =>
      /attachmentsHook rejected: Error: async boom/.test(warning),
    ).length,
    1,
  );
});

test("bounds the wait on a hook that never settles", async (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-hanging.js"),
      attachmentsTimeout: 50,
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(results.tests.length, 1);
  assert.equal(results.tests[0].attempt.meta, undefined);
  assert.equal(
    warnings.filter((warning) =>
      /attachmentsHook did not finish within 50ms/.test(warning),
    ).length,
    1,
  );
});

test("drops attachments from a hook that settles after the write", async (t) => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-slow.js"),
      attachmentsTimeout: 20,
      includeScreenshots: false,
      outputFile,
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  const resultsFile = path.join(projectRoot, outputFile);
  const written = fs.readFileSync(resultsFile, "utf8");

  // Long enough for the hook to settle, with the results already on disk.
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(fs.readFileSync(resultsFile, "utf8"), written);
  assert.equal(readJson(resultsFile).tests[0].attempt.meta, undefined);
  assert.equal(
    warnings.filter((warning) =>
      /attachmentsHook finished after the results were written/.test(warning),
    ).length,
    1,
  );
});

test("says so when the deferred write fails", async (t) => {
  const projectRoot = tmpdir();
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["failing"],
    file: "cypress/e2e/hook.cy.js",
  });

  // "results" is a file, so creating the directory for the output cannot succeed.
  fs.writeFileSync(path.join(projectRoot, "results"), "not a directory");

  const reporter = new RwxReporter(runner, {
    reporterOptions: {
      attachmentsHook: hookFixture("attachments-hook-async-state.js"),
      includeScreenshots: false,
      outputFile: "results/rwx.json",
      projectRoot,
    },
  });
  const warnings = captureWarnings(t);

  runner.emit("test", failing);
  runner.emit("fail", failing, new Error("boom"));
  runner.emit("end");

  await finish(reporter, 1);

  // Off the event there is nobody to throw at, so it must be logged rather than
  // vanish or become an unhandled rejection.
  assert.equal(
    warnings.filter((warning) => /failed to write results/.test(warning)).length,
    1,
  );
});

test("falls back to the default wait for an unusable attachmentsTimeout", (t) => {
  const warnings = captureWarnings(t);
  // `true` is the trap: coercing it would make a 1ms wait.
  const unusable = ["soon", "", 0, -1, Infinity, NaN, true, false, []];

  for (const attachmentsTimeout of unusable) {
    const reporter = new RwxReporter(new EventEmitter(), {
      reporterOptions: { attachmentsTimeout, projectRoot: tmpdir() },
    });

    assert.equal(
      reporter.attachmentsTimeout,
      30000,
      `attachmentsTimeout: ${JSON.stringify(attachmentsTimeout)}`,
    );
  }

  // Every one of them except "", which is how an unset option arrives.
  assert.equal(
    warnings.filter((warning) =>
      /attachmentsTimeout must be a positive number of milliseconds/.test(
        warning,
      ),
    ).length,
    unusable.length - 1,
  );
});

test("accepts a usable attachmentsTimeout, including a numeric string", (t) => {
  const warnings = captureWarnings(t);

  for (const [given, expected] of [
    [50, 50],
    ["50", 50],
    [1, 1],
  ]) {
    const reporter = new RwxReporter(new EventEmitter(), {
      reporterOptions: {
        attachmentsTimeout: given,
        projectRoot: tmpdir(),
      },
    });

    assert.equal(reporter.attachmentsTimeout, expected);
  }

  assert.deepEqual(warnings, []);
});

test("writes the results when the run ends without the final event", async () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const passing = createMochaTest({
    titlePath: ["passes"],
    file: "cypress/e2e/hook.cy.js",
  });
  const reporter = new RwxReporter(runner, {
    reporterOptions: { includeScreenshots: false, outputFile, projectRoot },
  });

  runner.emit("test", passing);
  runner.emit("pass", passing);

  // No `end`. Writing is the reporter's own business either way.
  await finish(reporter);

  assert.equal(readJson(path.join(projectRoot, outputFile)).tests.length, 1);
});

test("writes the results when the process ends before the hook settles", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const script = path.join(projectRoot, "run-reporter.js");

  // Neither the callback nor the promise arrives; results still must not go missing.
  fs.writeFileSync(
    script,
    `
const EventEmitter = require("node:events");
const RwxReporter = require(${JSON.stringify(path.join(__dirname, "..", "index.js"))});
const runner = new EventEmitter();
const failing = {
  title: "hangs",
  file: "cypress/e2e/hang.cy.js",
  titlePath: () => ["hangs"],
  fullTitle: () => "hangs",
};

new RwxReporter(runner, {
  reporterOptions: {
    attachmentsHook: ${JSON.stringify(hookFixture("attachments-hook-hanging.js"))},
    attachmentsTimeout: 600000,
    includeScreenshots: false,
    outputFile: ${JSON.stringify(outputFile)},
    projectRoot: ${JSON.stringify(projectRoot)},
  },
});

runner.emit("test", failing);
runner.emit("fail", failing, new Error("boom"));
runner.emit("end");
process.exit(0);
`,
    "utf8",
  );

  const finished = spawnSync(process.execPath, [script], { encoding: "utf8" });

  assert.equal(finished.status, 0, finished.stderr);

  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(results.tests.length, 1);
  assert.equal(results.tests[0].attempt.status.message, "boom");
});

test("locates a record from a spec seen elsewhere in the run", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createRetryProbe();

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  // The only test that reports is one there is no location on. The test that
  // could supply it started and then never reported an attempt of its own, so a
  // record has to take the spec from what the run saw rather than from itself.
  runner.emit("test", failing);
  runner.emit(
    "fail",
    createDegradedRetryTest({ title: "a different test" }),
    new Error("boom"),
  );
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(results.tests.length, 1);
  assert.equal(results.tests[0].name, "a different test");
  assert.equal(results.tests[0].location.file, "cypress/e2e/retries-on.cy.js");
});
