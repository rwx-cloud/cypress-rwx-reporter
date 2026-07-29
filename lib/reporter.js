const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAttempt,
  createResults,
  createTest,
  getFullTitle,
  getLocationFile,
  getTestKey,
  mergeAttemptMeta,
  screenshotMeta,
} = require("./results");
const { findFailureScreenshot } = require("./screenshots");
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

function errorFromTest(test) {
  if (!test) {
    return undefined;
  }

  return test.err || test.error || test._error;
}

function formatOutputFile(file, json, tests) {
  const hash = crypto.createHash("md5").update(json).digest("hex");
  const firstLocation = tests
    .map((test) => test.location && test.location.file)
    .find(Boolean);
  const spec = firstLocation ? firstLocation.replace(/[\\/]/g, "-") : "results";

  return file.replaceAll("[hash]", hash).replaceAll("[spec]", spec);
}

function writeJson(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${json}\n`, "utf8");
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
    // Cypress runs tests serially
    this.inFlightTest = null;
    this.now = () => new Date();

    runner.on("test", (test) => {
      this.inFlightTest = {
        key: getTestKey(test),
        record: this.addRecord(test),
        startedAt: this.now(),
        test,
      };
    });

    runner.on("retry", (test, error) => {
      this.recordAttempt(test, "failed", error);
    });

    runner.on("pass", (test) => {
      this.recordAttempt(test, "successful");
    });

    runner.on("fail", (test, error) => {
      this.recordAttempt(test, "failed", error);
    });

    runner.on("pending", (test) => {
      this.recordAttempt(test, "skipped");
    });

    runner.on("test end", () => {
      this.inFlightTest = null;
    });

    runner.on("end", () => {
      this.flush();
    });
  }

  addRecord(test) {
    const record = { attempts: [], test };

    this.records.push(record);

    return record;
  }

  // The test Cypress is running, when this event is one of its attempts. Null
  // otherwise — a test can be in flight and not be the one reporting, because
  // Cypress reports a skipped test before starting it. The title fallback is for
  // its `retry` event, which omits `parent` and `file` — cypress-io/cypress#27732.
  findInFlightTest(test) {
    if (this.inFlightTest === null) {
      return null;
    }

    if (getTestKey(test) === this.inFlightTest.key) {
      return this.inFlightTest;
    }

    const degraded = !getLocationFile(test) && Boolean(test.title);

    return degraded && test.title === this.inFlightTest.test.title
      ? this.inFlightTest
      : null;
  }

  failureScreenshot(test, statusKind, attemptNumber) {
    if (
      statusKind !== "failed" ||
      !booleanOption(this.reporterOptions.includeScreenshots, true)
    ) {
      return null;
    }

    return findFailureScreenshot(
      test,
      attemptNumber,
      this.reporterOptions,
      this.projectRoot,
    );
  }

  recordAttempt(test, statusKind, error) {
    const inFlight = this.findInFlightTest(test);
    const record = inFlight ? inFlight.record : this.addRecord(test);
    const attemptNumber = record.attempts.length + 1;
    const context = {
      attemptNumber,
      finishedAt: this.now(),
      screenshot: this.failureScreenshot(
        record.test,
        statusKind,
        attemptNumber,
      ),
      startedAt: attemptStartedAt(record, inFlight),
    };
    const attemptError =
      error || errorFromTest(test) || errorFromTest(record.test);
    const attempt = createAttempt(
      record.test,
      statusKind,
      attemptError,
      context,
    );

    this.applyAttachmentsHook(attempt, record.test, statusKind, attemptError, {
      ...context,
      projectRoot: this.projectRoot,
    });

    record.attempts.push(attempt);
  }

  applyAttachmentsHook(attempt, test, kind, error, context) {
    if (!this.attachmentsHook) {
      return;
    }

    const warn = (message) =>
      process.stdout.write(
        `${LOG_PREFIX} ${message} (${getFullTitle(test)}, attempt ${context.attemptNumber})\n`,
      );

    try {
      // Wrap `test` since it's read later
      const returned = callAttachmentsHook(
        this.attachmentsHook,
        [readOnly(test), kind, error, context],
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
        record.test,
        attempt.status.kind,
        index + 1,
      );

      if (screenshot) {
        mergeAttemptMeta(attempt, screenshotMeta(screenshot));
      }
    });
  }

  flush() {
    const reported = this.records.filter(
      (record) => record.attempts.length > 0,
    );
    // One spec per reporter instance, so the first location found is the spec.
    const specFile = this.records
      .map(({ test }) => getLocationFile(test))
      .find(Boolean);

    reported.forEach((record) => {
      this.attachMissingScreenshots(record);
    });

    const tests = reported.map(({ test, attempts }) =>
      createTest(test, attempts, specFile),
    );
    const results = createResults(tests);
    const json = JSON.stringify(results, null, 2);
    const outputFile = path.resolve(
      this.projectRoot,
      formatOutputFile(this.outputFile, json, tests),
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
RwxReporter.createResults = createResults;
RwxReporter.createTest = createTest;
RwxReporter.findFailureScreenshot = findFailureScreenshot;
RwxReporter.getLocationFile = getLocationFile;

module.exports = RwxReporter;
