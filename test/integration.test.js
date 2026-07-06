const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const cypress = require("cypress");

const projectRoot = path.join(__dirname, "fixtures", "cypress-project");
const resultsDir = path.join(projectRoot, "rwx-results");
const screenshotsDir = path.join(projectRoot, "cypress", "screenshots");
const videosDir = path.join(projectRoot, "cypress", "videos");

function cleanProjectOutputs() {
  fs.rmSync(resultsDir, { force: true, recursive: true });
  fs.rmSync(screenshotsDir, { force: true, recursive: true });
  fs.rmSync(videosDir, { force: true, recursive: true });
}

function readResults() {
  const files = fs
    .readdirSync(resultsDir)
    .filter((file) => file.endsWith(".json"));

  assert.equal(files.length, 1);

  return JSON.parse(fs.readFileSync(path.join(resultsDir, files[0]), "utf8"));
}

test("runs Cypress and writes RWX results with retries and screenshots", async (t) => {
  cleanProjectOutputs();
  t.after(cleanProjectOutputs);

  const run = await cypress.run({
    browser: "electron",
    configFile: path.join(projectRoot, "cypress.config.js"),
    project: projectRoot,
    quiet: true,
  });

  assert.equal(run.totalFailed, 0);
  assert.equal(run.totalPassed, 2);

  const results = readResults();
  const retried = results.tests.find(
    (result) =>
      result.name === "rwx reporter integration retries with a screenshot",
  );
  const pastAttempt = retried.pastAttempts[0];

  assert.equal(results.summary.tests, 2);
  assert.equal(results.summary.successful, 2);
  assert.equal(results.summary.retries, 1);
  assert.equal(results.summary.flaky, 1);
  assert.equal(results.summary.status.kind, "successful");
  assert.ok(retried);
  assert.equal(retried.attempt.status.kind, "successful");
  assert.equal(retried.pastAttempts.length, 1);
  assert.equal(pastAttempt.status.kind, "failed");
  assert.equal(pastAttempt.status.exception, "AssertionError");
  assert.match(pastAttempt.status.message, /expected 1 to equal 2/);
  assert.ok(pastAttempt.status.backtrace.length > 0);
  assert.equal(pastAttempt.meta.fileAttachments.length, 1);
  assert.equal(pastAttempt.meta.fileAttachments[0].name, "screenshot");
  assert.ok(fs.existsSync(pastAttempt.meta.fileAttachments[0].path));
  assert.match(
    pastAttempt.meta.fileAttachments[0].path,
    /cypress\/screenshots\/reporter\.cy\.js\/rwx reporter integration -- retries with a screenshot \(failed\)\.png$/,
  );
});
