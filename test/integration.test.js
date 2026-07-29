const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const cypress = require("cypress");

const projectRoot = path.join(__dirname, "fixtures", "cypress-project");
const retriesProjectRoot = path.join(
  __dirname,
  "fixtures",
  "cypress-retries-project",
);

// Everything a fixture run writes. Not every project produces all of them, and
// `force` makes removing one that was never created a no-op.
const OUTPUT_DIRECTORIES = [
  "rwx-results",
  "cypress/screenshots",
  "cypress/videos",
  "cypress/attachments",
  "cypress/attempts",
];

function cleanOutputs(root) {
  OUTPUT_DIRECTORIES.forEach((directory) =>
    fs.rmSync(path.join(root, directory), { force: true, recursive: true }),
  );
}

// The reporter writes one results file per spec. `spec` picks one out by the
// `[spec]` token in its filename; omit it for a project with a single spec.
function readResults(root, spec = "") {
  const directory = path.join(root, "rwx-results");
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.includes(spec) && file.endsWith(".json"));

  assert.equal(
    files.length,
    1,
    `expected one results file for ${spec || root}`,
  );

  return JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8"));
}

function attemptsOf(result) {
  return [...(result.pastAttempts || []), result.attempt];
}

function readAttemptNumbers(title) {
  return fs
    .readFileSync(
      path.join(
        retriesProjectRoot,
        "cypress",
        "attempts",
        "attempt-numbers.jsonl",
      ),
      "utf8",
    )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.title === title);
}

test("runs Cypress and writes RWX results with retries and screenshots", async (t) => {
  cleanOutputs(projectRoot);
  t.after(() => cleanOutputs(projectRoot));

  const run = await cypress.run({
    browser: "electron",
    configFile: path.join(projectRoot, "cypress.config.js"),
    project: projectRoot,
    quiet: true,
  });

  assert.equal(run.totalFailed, 0);
  assert.equal(run.totalPassed, 2);

  const results = readResults(projectRoot);
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
  // The reporter's discovered screenshot and the hook's HTML snapshot coexist.
  assert.deepEqual(Object.keys(pastAttempt.meta), ["screenshot"]);
  assert.match(
    pastAttempt.meta.screenshot.image,
    /cypress\/screenshots\/reporter\.cy\.js\/rwx reporter integration -- retries with a screenshot \(failed\)\.png$/,
  );
  assert.match(
    pastAttempt.meta.screenshot.html,
    /cypress\/attachments\/rwx-reporter-integration-retries-with-a-screenshot-1\.html$/,
  );
  [pastAttempt.meta.screenshot.image, pastAttempt.meta.screenshot.html].forEach(
    (file) => assert.ok(fs.existsSync(file), `missing ${file}`),
  );

  // The hook returns nothing for successful attempts, so it adds nothing.
  assert.equal(retried.attempt.meta, undefined);
  assert.equal(
    results.tests.find((result) => result.name.endsWith("passes")).attempt.meta,
    undefined,
  );
});

test("reports Cypress retries faithfully across spec shapes", async (t) => {
  cleanOutputs(retriesProjectRoot);
  t.after(() => cleanOutputs(retriesProjectRoot));

  const run = await cypress.run({
    browser: "electron",
    configFile: path.join(retriesProjectRoot, "cypress.config.js"),
    project: retriesProjectRoot,
    quiet: true,
  });

  assert.equal(run.totalPassed, 5);
  assert.equal(run.totalFailed, 4);
  assert.equal(run.totalPending, 5);

  await t.test("a failure retried to exhaustion stays one record", () => {
    const results = readResults(retriesProjectRoot, "always-fails.cy.js");
    const failing = results.tests.find((result) =>
      result.name.endsWith("always fails"),
    );
    const attempts = attemptsOf(failing);
    const baseName = "retries to exhaustion -- always fails (failed)";

    assert.equal(results.summary.tests, 2);
    assert.equal(results.summary.failed, 1);
    assert.equal(results.summary.successful, 1);
    assert.equal(results.summary.retries, 1);
    assert.equal(results.summary.flaky, 0);
    assert.equal(attempts.length, 3);

    attempts.forEach((attempt, index) => {
      assert.equal(attempt.status.kind, "failed");
      assert.match(attempt.status.message, /expected 1 to equal 2/);
      assert.ok(attempt.startedAt, `attempt ${index + 1} has no startedAt`);
      assert.ok(attempt.finishedAt, `attempt ${index + 1} has no finishedAt`);
    });

    // Cypress writes one screenshot per attempt, numbered from its own retry
    // counter, so its filenames are the oracle for the reporter's numbering.
    assert.deepEqual(
      attempts.map((attempt) => path.basename(attempt.meta.screenshot.image)),
      [
        `${baseName}.png`,
        `${baseName} (attempt 2).png`,
        `${baseName} (attempt 3).png`,
      ],
    );
    attempts.forEach((attempt) =>
      assert.ok(
        fs.existsSync(attempt.meta.screenshot.image),
        `missing ${attempt.meta.screenshot.image}`,
      ),
    );

    // Same agreement stated directly: the attempt number the reporter reports —
    // to the attachments hook, and to screenshot discovery — tracks Cypress's
    // retry counter rather than drifting behind it.
    const logged = readAttemptNumbers("always fails");

    assert.deepEqual(
      logged.map((entry) => entry.attemptNumber),
      [1, 2, 3],
    );
    assert.deepEqual(
      logged.map((entry) => entry.currentRetry),
      [0, 1, 2],
    );
  });

  await t.test("two retried failures keep their attempts apart", () => {
    const results = readResults(retriesProjectRoot, "two-failures.cy.js");

    assert.equal(results.summary.tests, 2);
    assert.equal(results.summary.failed, 2);
    assert.equal(results.summary.retries, 2);
    assert.equal(results.summary.flaky, 0);
    assert.deepEqual(
      results.tests.map((result) => result.name),
      ["two failures fails first", "two failures fails second"],
    );

    results.tests.forEach((result) => {
      const attempts = attemptsOf(result);

      assert.equal(attempts.length, 3);
      assert.deepEqual(
        attempts.map((attempt) => attempt.status.kind),
        ["failed", "failed", "failed"],
      );
    });
  });

  await t.test(
    "a retry that finally passes reports as flaky, not failed",
    () => {
      const results = readResults(retriesProjectRoot, "nested-flaky.cy.js");
      const result = results.tests[0];

      assert.equal(results.summary.tests, 1);
      assert.equal(results.summary.successful, 1);
      assert.equal(results.summary.failed, 0);
      assert.equal(results.summary.flaky, 1);
      assert.deepEqual(result.lineage, [
        "nested outer",
        "nested inner",
        "passes on the third attempt",
      ]);
      assert.deepEqual(
        attemptsOf(result).map((attempt) => attempt.status.kind),
        ["failed", "failed", "successful"],
      );
    },
  );

  await t.test("tests Cypress never starts are still reported", () => {
    const results = readResults(retriesProjectRoot, "pending.cy.js");

    assert.equal(results.summary.tests, 4);
    assert.equal(results.summary.skipped, 3);
    assert.equal(results.summary.successful, 1);
    assert.equal(results.summary.status.kind, "successful");

    // Cypress reports these without opening a `test`/`test end` window, so the
    // reporter has no in-flight test to take a location from.
    results.tests.forEach((result) =>
      assert.ok(result.location.file, `${result.name} has no location`),
    );
    assert.deepEqual(
      results.tests
        .filter((result) => result.attempt.status.kind === "skipped")
        .map((result) => result.name),
      [
        "pending shapes has no body",
        "pending shapes is explicitly skipped",
        "skipped suite is inside a skipped suite",
      ],
    );
  });

  await t.test("two skipped tests sharing a title stay two tests", () => {
    const results = readResults(retriesProjectRoot, "duplicate-skipped.cy.js");

    assert.equal(results.summary.tests, 3);
    assert.equal(results.summary.skipped, 2);
    assert.equal(results.summary.successful, 1);
    // Neither skip is an attempt of the other, so nothing here retried.
    assert.equal(results.summary.retries, 0);
    assert.deepEqual(
      results.tests.map((result) => result.name),
      [
        "duplicate skipped shares a title",
        "duplicate skipped runs between them",
        "duplicate skipped shares a title",
      ],
    );
  });

  await t.test("two tests sharing a title stay two tests", () => {
    const results = readResults(retriesProjectRoot, "duplicate-titles.cy.js");

    assert.equal(results.summary.tests, 2);
    assert.equal(results.summary.successful, 1);
    assert.equal(results.summary.failed, 1);
    // Merging them made the failure read as a flaky retry of the passing test,
    // which is a failure a consumer could then forgive.
    assert.equal(results.summary.flaky, 0);
    // Telling them apart is the reporter's business, not the report's. Captain
    // derives a test's identity from its name and detects the collision itself;
    // a suffix invented here would depend on execution order and so would not
    // name the same test twice across runs.
    assert.deepEqual(
      results.tests.map((result) => result.name),
      ["duplicate titles shares a title", "duplicate titles shares a title"],
    );
    assert.deepEqual(
      results.tests.map((result) => attemptsOf(result).length),
      [1, 3],
    );
    assert.deepEqual(
      results.tests.map((result) => result.attempt.status.kind),
      ["successful", "failed"],
    );
  });
});
