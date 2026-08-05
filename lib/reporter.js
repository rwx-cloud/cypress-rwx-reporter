const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAttempt,
  createOtherError,
  createReport,
  createResult,
  durationInNanoseconds,
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
  OPTION: HOOK_OPTION,
  callAttachmentsHook,
  isThenable,
  loadAttachmentsHook,
  validateAttachments,
} = require("./attachments");
const { testView } = require("./test-view");

const LOG_PREFIX = "[@rwx-cloud/cypress-rwx-reporter]";
// Cypress waits on the completion callback without a timeout of its own, so an
// unsettled hook promise would hang the run.
const DEFAULT_ATTACHMENTS_TIMEOUT = 30000;

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

function timeoutOption(value, warn) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ATTACHMENTS_TIMEOUT;
  }

  const milliseconds = typeof value === "number" ? value : Number(value);

  // `true` would otherwise coerce to a 1ms wait that fails every hook silently.
  if (
    typeof value === "boolean" ||
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0
  ) {
    warn(
      `attachmentsTimeout must be a positive number of milliseconds, received ${JSON.stringify(value)}. Using ${DEFAULT_ATTACHMENTS_TIMEOUT}ms.`,
    );

    return DEFAULT_ATTACHMENTS_TIMEOUT;
  }

  return milliseconds;
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

// Cypress reports a hook failure as a test, so this is all that separates it from
// a test failing in its own body.
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

// A suite Cypress skipped outright emits no `suite` event.
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

// Cypress emits no second `test` event for a retry.
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
    this.attachmentsTimeout = timeoutOption(
      this.reporterOptions.attachmentsTimeout,
      (message) => this.log(message),
    );
    this.records = [];
    this.inFlightTest = null;
    this.hookFailures = [];
    this.pendingHookFailures = [];
    this.rootSuite = null;
    this.now = () => new Date();
    this.outstandingHookWork = new Set();
    this.written = false;
    this.deferred = null;
    this.finalized = false;
    this.reported = [];
    this.recorded = [];
    this.writeOnExit = () => this.writeResults();

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
      this.settleFinalDuration(runnable);
      this.inFlightTest = null;
    });

    runner.on("end", () => {
      this.finalizeRecords();

      if (this.outstandingHookWork.size === 0) {
        this.flush();

        return;
      }

      this.deferWrite();
    });
  }

  log(message) {
    process.stdout.write(`${LOG_PREFIX} ${message}\n`);
  }

  addRecord(runnable) {
    const record = { attempts: [], runnable };

    this.records.push(record);

    return record;
  }

  // Null when a test is in flight but is not the one reporting: Cypress reports a
  // skipped test before starting it. The title fallback is for the `retry` event,
  // which omits `parent` and `file` — cypress-io/cypress#27732.
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

  // Buffered rather than pushed onto `record.attempts`, which would advance the
  // attempt number screenshots are keyed on.
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
  // down for good; a test that recovered on a retry loses the id.
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
    // Cypress emits no `pass` for a test whose `after` hook failed, and a body
    // failure would have reported by now, so reporting nothing means it passed.
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

  recordAttempt(reported, statusKind, error) {
    const inFlight = this.findInFlightTest(reported);
    const record = inFlight ? inFlight.record : this.addRecord(reported);
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
    // A retried test that finally passes still carries the previous attempt's
    // error, which the fallbacks would hand to a hook branching on `error`.
    const attemptError =
      statusKind === "failed"
        ? error ||
          errorFromRunnable(reported) ||
          errorFromRunnable(record.runnable)
        : undefined;
    // `reported` rather than `record.runnable`: Cypress reports a retried
    // attempt through a per-attempt object and only afterwards copies that
    // attempt's outcome onto the long-lived test, so the long-lived one still
    // describes the previous attempt. Identity comes from the record instead
    // (`createResult`), which is why the degraded `retry` event is usable here.
    const attempt = createAttempt(reported, statusKind, attemptError, context);

    this.applyAttachmentsHook(
      attempt,
      record.runnable,
      reported,
      statusKind,
      attemptError,
      {
        ...context,
        projectRoot: this.projectRoot,
      },
    );

    if (inFlight) {
      inFlight.reportedOutcome = true;
      inFlight.lastAttempt = attempt;
    }

    record.attempts.push(attempt);

    return record;
  }

  // Cypress writes an attempt's duration onto the long-lived test object only
  // after emitting the event that reported the attempt. Every attempt but the
  // last has a later event to be read from — the next `retry`, which carries its
  // own attempt's duration — but the last attempt of a test that ends in failure
  // has only `test end`, by which point the long-lived object has caught up. A
  // final attempt that passed is already right, so this settles to the same
  // value. Measured against cypress@15.18.0.
  settleFinalDuration(runnable) {
    const inFlight = this.findInFlightTest(runnable);
    const attempt = inFlight && inFlight.lastAttempt;

    if (!attempt) {
      return;
    }

    const duration = durationInNanoseconds(runnable);

    if (duration !== null) {
      attempt.durationInNanoseconds = duration;
    }
  }

  applyAttachmentsHook(attempt, liveRunnable, reported, kind, error, context) {
    if (!this.attachmentsHook) {
      return;
    }

    const warn = (message) =>
      this.log(
        `${message} (${getFullTitle(liveRunnable)}, attempt ${context.attemptNumber})`,
      );

    const { view, expire } = testView(liveRunnable, reported);

    try {
      const returned = callAttachmentsHook(
        this.attachmentsHook,
        [view, kind, error, context],
        warn,
      );

      if (isThenable(returned)) {
        this.awaitAttachments(returned, attempt, warn);

        return;
      }

      this.mergeAttachments(attempt, returned, warn);
    } catch (failure) {
      warn(`failed to apply attachments: ${failure}`);
    } finally {
      expire();
    }
  }

  mergeAttachments(attempt, returned, warn) {
    try {
      mergeAttemptMeta(
        attempt,
        validateAttachments(returned, warn, this.projectRoot),
      );
    } catch (failure) {
      warn(`failed to apply attachments: ${failure}`);
    }
  }

  // The attempt is already on its record, so a late merge still lands on the right
  // one. All the results need is to not be written until then.
  awaitAttachments(returned, attempt, warn) {
    const pending = { warn };

    pending.settled = Promise.resolve(returned)
      .then(
        (value) => {
          if (this.written) {
            warn(
              `${HOOK_OPTION} finished after the results were written; its attachments were dropped`,
            );

            return;
          }

          this.mergeAttachments(attempt, value, warn);
        },
        (failure) => {
          warn(
            `${HOOK_OPTION} rejected: ${failure && failure.stack ? failure.stack : failure}`,
          );
        },
      )
      .then(() => {
        this.outstandingHookWork.delete(pending);
      });

    this.outstandingHookWork.add(pending);
  }

  settleAttachments() {
    const pending = [...this.outstandingHookWork];

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending
          .filter((entry) => this.outstandingHookWork.has(entry))
          .forEach((entry) =>
            entry.warn(
              `${HOOK_OPTION} did not finish within ${this.attachmentsTimeout}ms; writing the results without its attachments`,
            ),
          );

        resolve();
      }, this.attachmentsTimeout);

      // Deliberately not unref'd: exiting silently would cost the warning above.
      Promise.all(pending.map((entry) => entry.settled)).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // Off the event there is no caller left to throw at, so a failure would surface
  // as an unhandled rejection or vanish from an `exit` listener.
  writeResults() {
    try {
      this.flush();
    } catch (failure) {
      this.log(
        `failed to write results: ${failure && failure.stack ? failure.stack : failure}`,
      );
    }
  }

  // `exit` is the last resort for a completion callback that never arrives.
  deferWrite() {
    if (!this.deferred) {
      process.once("exit", this.writeOnExit);
      this.deferred = this.settleAttachments().then(
        () => this.writeResults(),
        () => this.writeResults(),
      );
    }

    return this.deferred;
  }

  // What makes an async hook possible: Cypress calls `done` once per spec and
  // waits for the callback before moving on. Measured against cypress@15.18.0.
  done(failures, callback) {
    const finish = () => {
      if (typeof callback === "function") {
        callback(failures);
      }
    };

    this.finalizeRecords();

    const pendingWrite =
      this.deferred ||
      (this.outstandingHookWork.size > 0 ? this.deferWrite() : null);

    if (pendingWrite) {
      pendingWrite.then(finish, finish);

      return;
    }

    this.flush();
    finish();
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
    // test alone, so an unclaimed one of those is the hook's.
    const testNamed = findFailureScreenshot(
      failure.testRunnable,
      failure.attemptNumber,
      this.reporterOptions,
      this.projectRoot,
    );

    return testNamed && !claimed.has(testNamed) ? testNamed : null;
  }

  // No event reported this attempt, so the declared test is both the live and the
  // reported view of it.
  skippedAttempt(runnable) {
    const context = { attemptNumber: 1, screenshot: null };
    const attempt = createAttempt(runnable, "skipped", undefined, context);

    this.applyAttachmentsHook(
      attempt,
      runnable,
      runnable,
      "skipped",
      undefined,
      {
        ...context,
        projectRoot: this.projectRoot,
      },
    );

    return attempt;
  }

  // Matched by count rather than identity: two tests in one spec may share a full
  // title.
  skippedRecords(reported) {
    const unmatched = new Map();

    reported.forEach(({ runnable }) => {
      const key = getTestKey(runnable);

      unmatched.set(key, (unmatched.get(key) || 0) + 1);
    });

    return declaredTests(this.rootSuite).flatMap((runnable) => {
      const key = getTestKey(runnable);
      const covered = unmatched.get(key) || 0;

      if (covered > 0) {
        unmatched.set(key, covered - 1);

        return [];
      }

      return [{ runnable, attempts: [this.skippedAttempt(runnable)] }];
    });
  }

  // Must run before the wait, not during the write: synthesising a skipped attempt
  // invokes the hook, and doing that during the write would leave an async hook's
  // work with nothing left to await it.
  finalizeRecords() {
    if (!this.finalized) {
      this.finalized = true;
      this.keepUnresolvedHookFailures();
      this.reported = this.records.filter(
        (record) => record.attempts.length > 0,
      );
      this.recorded = [
        ...this.reported,
        ...this.skippedRecords(this.reported),
      ];
    }

    return this.recorded;
  }

  flush() {
    // Ahead of the write-once check, so the listener goes either way.
    process.removeListener("exit", this.writeOnExit);

    if (this.written) {
      return;
    }

    this.written = true;

    const recorded = this.finalizeRecords();
    const reported = this.reported;
    // One spec per reporter instance, so the first location found is the spec.
    const specFile =
      this.records.map(({ runnable }) => getLocationFile(runnable)).find(Boolean) ||
      getLocationFile(this.rootSuite);

    reported.forEach((record) => {
      this.attachMissingScreenshots(record);
    });

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
