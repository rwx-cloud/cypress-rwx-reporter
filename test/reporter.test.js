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

  runner.emit("test", flaky);
  runner.emit("retry", flaky, new Error("first failure"));
  flaky.duration = 25;
  runner.emit("test", flaky);
  runner.emit("pass", flaky);
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
  const fullTest = createMochaTest({
    titlePath: ["checkout", "submits"],
    file: "cypress/e2e/checkout.cy.js",
    duration: 20,
  });
  const retryTest = createMochaTest({
    titlePath: ["submits"],
    duration: 20,
  });

  new RwxReporter(runner, {
    reporterOptions: { outputFile, projectRoot, includeScreenshots: false },
  });

  runner.emit("test", fullTest);
  runner.emit("retry", retryTest, new Error("first failure"));
  fullTest.duration = 25;
  runner.emit("test", fullTest);
  runner.emit("pass", fullTest);
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));

  assert.equal(results.summary.tests, 1);
  assert.equal(results.tests[0].name, "checkout submits");
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
  runner.emit("retry", retried, new Error("first failure"));
  runner.emit("test", retried);
  runner.emit("fail", retried, new Error("second failure"));
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const finalAttempt = results.tests[0].attempt;

  assert.equal(results.tests[0].pastAttempts[0].meta, undefined);
  assert.deepEqual(finalAttempt.meta.fileAttachments, [
    { name: "screenshot", path: screenshotPath },
  ]);
  assert.deepEqual(finalAttempt.meta.screenshot, { image: screenshotPath });
});

test("calls adjustAttempt when it's set", () => {
  const projectRoot = tmpdir();
  const outputFile = "results/rwx.json";
  const runner = new EventEmitter();
  const failing = createMochaTest({
    titlePath: ["adjust"],
    file: "cypress/e2e/adjust.cy.js",
  });

  new RwxReporter(runner, { reporterOptions: { outputFile, projectRoot, adjustAttempt: `${__dirname}/fixtures/adjustAttemptMock.js` } });

  runner.emit("test", failing);
  runner.emit("retry", failing, new Error("failure"));
  runner.emit("end");

  const results = readJson(path.join(projectRoot, outputFile));
  const attempt = results.tests[0].attempt;

  assert.equal(attempt.meta.html, 'fromAdjustAttempt-adjust-failed-failure-1');
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
