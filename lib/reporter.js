const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAttempt,
  createOtherError,
  createReport,
  createResult,
  getFullTitle,
  getLocationFile,
  getTestKey,
  mergeAttemptMeta,
  screenshotMeta,
} = require("./results");
const {
  findFailureScreenshot,
  findHookFailureScreenshot,
} = require("./screenshots");
const {
  callAttachmentsHook,
  loadAttachmentsHook,
  readOnly,
  validateAttachments,
} = require("./attachments");

const LOG_PREFIX = "[@rwx-cloud/cypress-rwx-reporter]";

function getReporterOptions(options) {
  if (!options) {
    return {};
  }

  if (options.reporterOptions) {
    return options.reporterOptions;
  }

  return Object.keys(options).reduce((reporterOptions, key) => {
    if (key.startsWith("reporterOptions.")) {
      reporterOptions[key.slice("reporterOptions.".length)] = options[key];
    }

    return reporterOptions;
  }, {});
}

function getOutputFile(reporterOptions) {
  return (
    reporterOptions.outputFile ||
    reporterOptions.resultsFile ||
    reporterOptions.rwxFile ||
    process.env.CYPRESS_RWX_RESULTS_FILE ||
    "rwx-results/results-[hash].json"
  );
}

function getProjectRoot(reporterOptions, options) {
  return path.resolve(
    reporterOptions.projectRoot ||
    options.projectRoot ||
    (options.config && options.config.projectRoot) ||
    (options.reporterOptions &&
      options.reporterOptions.config &&
      options.reporterOptions.config.projectRoot) ||
    process.cwd(),
  );
}

function booleanOption(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return !["false", "0", "no", "off"].includes(value.toLowerCase());
  }

  return Boolean(value);
}

function hasScreenshotImage(attempt) {
  return Boolean(
    attempt.meta && attempt.meta.screenshot && attempt.meta.screenshot.image,
  );
}

function errorFromRunnable(runnable) {
  if (!runnable) {
    return undefined;
  }

  return runnable.err || runnable.error || runnable._error;
}

function formatOutputFile(file, json, results) {
  const hash = crypto.createHash("md5").update(json).digest("hex");
  const firstLocation = results
    .map((result) => result.location && result.location.file)
    .find(Boolean);
  const spec = firstLocation ? firstLocation.replace(/[\\/]/g, "-") : "results";

  return file.replaceAll("[hash]", hash).replaceAll("[spec]", spec);
}

function writeJson(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${json}\n`, "utf8");
}

// A hook failure still reports `type: "test"`, so `failedFromHookId` is the only
// thing separating it from a test failing in its own body.
function isHookFailure(runnable) {
  return Boolean(runnable && runnable.failedFromHookId);
}

function hookNameOf(runnable) {
  return runnable && typeof runnable.failedFromHookName === "string"
    ? runnable.failedFromHookName
    : null;
}

function failedAfterBody(runnable) {
  return Boolean(hookNameOf(runnable)?.startsWith("after"));
}

// A suite Cypress skipped outright emits no `suite` event, so its tests are
// reachable only by walking the graph.
function declaredTests(suite) {
  if (!suite) {
    return [];
  }

  const tests = Array.isArray(suite.tests) ? suite.tests : [];
  const suites = Array.isArray(suite.suites) ? suite.suites : [];

  return [...tests, ...suites.flatMap(declaredTests)];
}

function insertBeforeLast(items, item) {
  items.splice(-1, 0, item);
}

function rootOf(suite) {
  let current = suite;

  while (current && current.parent) {
    current = current.parent;
  }

  return current;
}

// Cypress emits no second `test` event for a retry, so an attempt after the first
// starts where the one before it ended.
function attemptStartedAt(record, inFlight) {
  const previous = record.attempts.at(-1);

  return previous?.finishedAt
    ? new Date(previous.finishedAt)
    : inFlight?.startedAt;
}

class RwxReporter {
  constructor(runner, options = {}) {
    this.runner = runner;
    this.reporterOptions = getReporterOptions(options);
    this.projectRoot = getProjectRoot(this.reporterOptions, options);
    this.outputFile = getOutputFile(this.reporterOptions);
    this.attachmentsHook = loadAttachmentsHook(
      this.reporterOptions.attachmentsHook,
      this.projectRoot,
    );
    this.records = [];
    this.inFlightTest = null;
    this.hookFailures = [];
    this.pendingHookFailures = [];
    this.rootSuite = null;
    this.now = () => new Date();

    // Mocha evaluates the whole spec before running it, so the graph is complete.
    runner.on("suite", (suite) => {
      this.rootSuite = rootOf(suite) || this.rootSuite;
    });

    runner.on("test", (runnable) => {
      this.inFlightTest = {
        key: getTestKey(runnable),
        record: this.addRecord(runnable),
        startedAt: this.now(),
        runnable,
      };
    });

    runner.on("retry", (runnable, error) => {
      if (isHookFailure(runnable)) {
        this.bufferHookFailure(runnable, error);

        return;
      }

      this.recordAttempt(runnable, "failed", error);
    });

    runner.on("pass", (runnable) => {
      this.recordAttempt(runnable, "successful");
    });

    runner.on("fail", (runnable, error) => {
      if (isHookFailure(runnable)) {
        this.bufferHookFailure(runnable, error);

        return;
      }

      this.recordAttempt(runnable, "failed", error);
    });

    runner.on("pending", (runnable) => {
      this.recordAttempt(runnable, "skipped");
    });

    runner.on("test end", (runnable) => {
      this.closeTestEndedInHook(runnable);
      this.inFlightTest = null;
    });

    runner.on("end", () => {
      this.flush();
    });
  }

  addRecord(runnable) {
    const record = { attempts: [], runnable };

    this.records.push(record);

    return record;
  }

  // The test Cypress is running, when this event is one of its attempts. Null
  // otherwise — a test can be in flight and not be the one reporting, because
  // Cypress reports a skipped test before starting it. The title fallback is for
  // its `retry` event, which omits `parent` and `file` — cypress-io/cypress#27732.
  findInFlightTest(runnable) {
    if (this.inFlightTest === null) {
      return null;
    }

    if (getTestKey(runnable) === this.inFlightTest.key) {
      return this.inFlightTest;
    }

    const degraded = !getLocationFile(runnable) && Boolean(runnable.title);

    return degraded && runnable.title === this.inFlightTest.runnable.title
      ? this.inFlightTest
      : null;
  }

  failureScreenshot(runnable, statusKind, attemptNumber) {
    if (
      statusKind !== "failed" ||
      !booleanOption(this.reporterOptions.includeScreenshots, true)
    ) {
      return null;
    }

    return findFailureScreenshot(
      runnable,
      attemptNumber,
      this.reporterOptions,
      this.projectRoot,
    );
  }

  // Staying out of `record.attempts` is what keeps a hook failure from advancing
  // the attempt number screenshots are keyed on.
  bufferHookFailure(runnable, error) {
    const inFlight = this.findInFlightTest(runnable);
    const record = inFlight ? inFlight.record : null;
    const attemptError = error || errorFromRunnable(runnable);

    this.pendingHookFailures.push({
      runnable,
      error: attemptError,
      record,
      attempt: createAttempt(
        record ? record.runnable : runnable,
        "failed",
        attemptError,
        {
          finishedAt: this.now(),
          startedAt: attemptStartedAt(record || { attempts: [] }, inFlight),
        },
      ),
    });
  }

  // `failedFromHookId` survives onto `test end` only when the hook took the test
  // down for good; a test that recovered on a retry keeps `failedFromHookName`
  // but loses the id.
  resolveHookFailures(endedRunnable) {
    const failures = this.pendingHookFailures;

    this.pendingHookFailures = [];

    if (isHookFailure(endedRunnable)) {
      failures.forEach((failure, index) =>
        this.keepHookFailure(failure, endedRunnable, index + 1),
      );

      return;
    }

    failures.forEach((failure) => this.forgiveHookFailure(failure));
  }

  keepHookFailure(failure, endedRunnable, attemptNumber) {
    this.hookFailures.push({
      ...failure,
      attemptNumber,
      hookName: hookNameOf(failure.runnable) || hookNameOf(endedRunnable),
      testRunnable:
        endedRunnable || (failure.record && failure.record.runnable) || null,
    });
  }

  // Cypress calls a run green when a retry recovers from a failing hook.
  forgiveHookFailure(failure) {
    if (!failure.record) {
      return;
    }

    insertBeforeLast(failure.record.attempts, failure.attempt);
  }

  keepUnresolvedHookFailures() {
    this.pendingHookFailures.forEach((failure, index) =>
      this.keepHookFailure(failure, null, index + 1),
    );
    this.pendingHookFailures = [];
  }

  closeTestEndedInHook(runnable) {
    // Cypress emits no `pass` for a test whose `after` hook failed. A body failure
    // would have reported by now, so a test that reported nothing passed.
    if (
      this.inFlightTest &&
      !this.inFlightTest.reportedOutcome &&
      isHookFailure(runnable) &&
      failedAfterBody(runnable)
    ) {
      this.recordAttempt(runnable, "successful");
    }

    this.resolveHookFailures(runnable);
  }

  recordAttempt(runnable, statusKind, error) {
    const inFlight = this.findInFlightTest(runnable);
    const record = inFlight ? inFlight.record : this.addRecord(runnable);
    const attemptNumber = record.attempts.length + 1;
    const context = {
      attemptNumber,
      finishedAt: this.now(),
      screenshot: this.failureScreenshot(
        record.runnable,
        statusKind,
        attemptNumber,
      ),
      startedAt: attemptStartedAt(record, inFlight),
    };
    const attemptError =
      error ||
      errorFromRunnable(runnable) ||
      errorFromRunnable(record.runnable);
    const attempt = createAttempt(
      record.runnable,
      statusKind,
      attemptError,
      context,
    );

    this.applyAttachmentsHook(
      attempt,
      record.runnable,
      statusKind,
      attemptError,
      {
        ...context,
        projectRoot: this.projectRoot,
      },
    );

    if (inFlight) {
      inFlight.reportedOutcome = true;
    }

    record.attempts.push(attempt);

    return record;
  }

  applyAttachmentsHook(attempt, runnable, kind, error, context) {
    if (!this.attachmentsHook) {
      return;
    }

    const warn = (message) =>
      process.stdout.write(
        `${LOG_PREFIX} ${message} (${getFullTitle(runnable)}, attempt ${context.attemptNumber})\n`,
      );

    try {
      // Wrap it, since the hook could hold on to it
      const returned = callAttachmentsHook(
        this.attachmentsHook,
        [readOnly(runnable), kind, error, context],
        warn,
      );

      mergeAttemptMeta(
        attempt,
        validateAttachments(returned, warn, this.projectRoot),
      );
    } catch (failure) {
      warn(`failed to apply attachments: ${failure}`);
    }
  }

  attachMissingScreenshots(record) {
    record.attempts.forEach((attempt, index) => {
      if (hasScreenshotImage(attempt)) {
        return;
      }

      const screenshot = this.failureScreenshot(
        record.runnable,
        attempt.status.kind,
        index + 1,
      );

      if (screenshot) {
        mergeAttemptMeta(attempt, screenshotMeta(screenshot));
      }
    });
  }

  hookScreenshot(failure, claimed) {
    if (!booleanOption(this.reporterOptions.includeScreenshots, true)) {
      return null;
    }

    const named = findHookFailureScreenshot(
      failure.testRunnable,
      failure.hookName,
      failure.attemptNumber,
      this.reporterOptions,
      this.projectRoot,
    );

    if (named || !failure.testRunnable) {
      return named;
    }

    // Cypress names the earlier attempts of a retried `before` hook after the
    // test alone, so those are the hook's too — unless the test claimed one.
    const testNamed = findFailureScreenshot(
      failure.testRunnable,
      failure.attemptNumber,
      this.reporterOptions,
      this.projectRoot,
    );

    return testNamed && !claimed.has(testNamed) ? testNamed : null;
  }

  skippedAttempt(runnable) {
    const context = { attemptNumber: 1, screenshot: null };
    const attempt = createAttempt(runnable, "skipped", undefined, context);

    this.applyAttachmentsHook(attempt, runnable, "skipped", undefined, {
      ...context,
      projectRoot: this.projectRoot,
    });

    return attempt;
  }

  // Matched by count rather than identity, because two tests in one spec are
  // allowed to share a full title.
  skippedRecords(reported) {
    const outstanding = new Map();

    reported.forEach(({ runnable }) => {
      const key = getTestKey(runnable);

      outstanding.set(key, (outstanding.get(key) || 0) + 1);
    });

    return declaredTests(this.rootSuite).flatMap((runnable) => {
      const key = getTestKey(runnable);
      const covered = outstanding.get(key) || 0;

      if (covered > 0) {
        outstanding.set(key, covered - 1);

        return [];
      }

      return [{ runnable, attempts: [this.skippedAttempt(runnable)] }];
    });
  }

  flush() {
    this.keepUnresolvedHookFailures();

    const reported = this.records.filter(
      (record) => record.attempts.length > 0,
    );
    // One spec per reporter instance, so the first location found is the spec.
    const specFile =
      this.records.map(({ runnable }) => getLocationFile(runnable)).find(Boolean) ||
      getLocationFile(this.rootSuite);

    reported.forEach((record) => {
      this.attachMissingScreenshots(record);
    });

    const recorded = [...reported, ...this.skippedRecords(reported)];
    const results = recorded.map(({ runnable, attempts }) =>
      createResult(runnable, attempts, specFile),
    );
    const claimed = new Set(
      recorded
        .flatMap(({ attempts }) => attempts)
        .map((attempt) => attempt.meta?.screenshot?.image)
        .filter(Boolean),
    );
    const otherErrors = this.hookFailures.map((failure) =>
      createOtherError(failure.runnable, failure.error, specFile, {
        hookName: failure.hookName,
        // Deferred to here because Cypress writes the file after the event.
        screenshot: this.hookScreenshot(failure, claimed),
      }),
    );
    const report = createReport(results, otherErrors);
    const json = JSON.stringify(report, null, 2);
    const outputFile = path.resolve(
      this.projectRoot,
      formatOutputFile(this.outputFile, json, results),
    );

    writeJson(outputFile, json);

    if (booleanOption(this.reporterOptions.toConsole, false)) {
      process.stdout.write(`${json}\n`);
    }
  }
}

RwxReporter.getReporterOptions = getReporterOptions;
RwxReporter.getProjectRoot = getProjectRoot;
RwxReporter.createAttempt = createAttempt;
RwxReporter.createReport = createReport;
RwxReporter.createResult = createResult;
RwxReporter.findFailureScreenshot = findFailureScreenshot;
RwxReporter.getLocationFile = getLocationFile;

module.exports = RwxReporter;
