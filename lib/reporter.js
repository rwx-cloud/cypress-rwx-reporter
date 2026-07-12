const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAttempt,
  createResults,
  createTest,
  findFailureScreenshot,
  getLocationFile,
  getTestKey,
} = require("./results");

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

function hasFileAttachments(attempt) {
  return (
    attempt.meta &&
    Array.isArray(attempt.meta.fileAttachments) &&
    attempt.meta.fileAttachments.some((attachment) => attachment.path)
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

class RwxReporter {
  constructor(runner, options = {}) {
    this.runner = runner;
    this.reporterOptions = getReporterOptions(options);
    this.projectRoot = getProjectRoot(this.reporterOptions, options);
    this.outputFile = getOutputFile(this.reporterOptions);
    this.tests = new Map();
    this.activeStarts = new Map();
    this.activeTests = new Map();
    this.now = () => new Date();

    runner.on("test", (test) => {
      const key = getTestKey(test);

      this.activeStarts.set(key, this.now());
      this.activeTests.set(key, test);
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

    runner.on("end", () => {
      this.flush();
    });
  }

  testKey(test) {
    const key = getTestKey(test);

    if (this.activeStarts.has(key)) {
      return key;
    }

    if (!getLocationFile(test) && this.activeStarts.size === 1) {
      return Array.from(this.activeStarts.keys())[0];
    }

    return key;
  }

  recordAttempt(test, statusKind, error) {
    const key = this.testKey(test);
    const entry = this.tests.get(key) || {
      test: this.activeTests.get(key) || test,
      attempts: [],
    };
    const attemptNumber = entry.attempts.length + 1;
    const startedAt = this.activeStarts.get(key);
    const finishedAt = this.now();
    const screenshot =
      statusKind === "failed" &&
      booleanOption(this.reporterOptions.includeScreenshots, true)
        ? findFailureScreenshot(
            entry.test,
            attemptNumber,
            this.reporterOptions,
            this.projectRoot,
          )
        : null;
    const attemptError =
      error || errorFromTest(test) || errorFromTest(entry.test);
    const attemptContext = {
      attemptNumber,
      finishedAt,
      screenshot,
      startedAt,
    };
    const attempt = createAttempt(entry.test, statusKind, attemptError, attemptContext);

    this.attachMissingScreenshots(entry.test, attempt, attemptNumber);

    if (this.reporterOptions.adjustAttempt) {
      const adjustAttempt = require(this.reporterOptions.adjustAttempt).default || require(this.reporterOptions.adjustAttempt);
      adjustAttempt(attempt, entry.test, statusKind, attemptError, attemptContext);
    }

    entry.attempts.push(attempt);
    this.tests.set(key, entry);
    this.activeStarts.delete(key);
    this.activeTests.delete(key);
  }

  attachMissingScreenshots(test, attempt, attemptNumber) {
    if (!booleanOption(this.reporterOptions.includeScreenshots, true)) {
      return;
    }

    if (attempt.status.kind !== "failed" || hasFileAttachments(attempt)) {
      return;
    }

    const screenshot = findFailureScreenshot(
      test,
      attemptNumber,
      this.reporterOptions,
      this.projectRoot,
    );

    if (!screenshot) {
      return;
    }

    attempt.meta = attempt.meta || {};
    attempt.meta.fileAttachments = [{ name: "screenshot", path: screenshot }];
    attempt.meta.screenshot = { image: screenshot };
  }

  flush() {
    const entries = Array.from(this.tests.values());

    const tests = entries.map(({ test, attempts }) =>
      createTest(test, attempts),
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
