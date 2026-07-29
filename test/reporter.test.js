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
  t.mock.method(process.stdout, "write", () => true);

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
  const warnings = process.stdout.write.mock.calls.map(
    (call) => call.arguments[0],
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

  t.mock.method(process.stdout, "write", () => true);

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
  const warnings = process.stdout.write.mock.calls.map(
    (call) => call.arguments[0],
  );

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
