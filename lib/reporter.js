const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAttempt,
  createReport,
  createResult,
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
    this.now = () => new Date();

    runner.on("test", (runnable) => {
      this.inFlightTest = {
        key: getTestKey(runnable),
        record: this.addRecord(runnable),
        startedAt: this.now(),
        runnable,
      };
    });

    runner.on("retry", (runnable, error) => {
      this.recordAttempt(runnable, "failed", error);
    });

    runner.on("pass", (runnable) => {
      this.recordAttempt(runnable, "successful");
    });

    runner.on("fail", (runnable, error) => {
      this.recordAttempt(runnable, "failed", error);
    });

    runner.on("pending", (runnable) => {
      this.recordAttempt(runnable, "skipped");
    });

    runner.on("test end", () => {
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

    record.attempts.push(attempt);
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

  flush() {
    const reported = this.records.filter(
      (record) => record.attempts.length > 0,
    );
    // One spec per reporter instance, so the first location found is the spec.
    const specFile = this.records
      .map(({ runnable }) => getLocationFile(runnable))
      .find(Boolean);

    reported.forEach((record) => {
      this.attachMissingScreenshots(record);
    });

    const results = reported.map(({ runnable, attempts }) =>
      createResult(runnable, attempts, specFile),
    );
    const report = createReport(results);
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
