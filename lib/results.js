// The RWX v1 schema mapping. No filesystem, no Cypress conventions.
function valueFromFunction(target, name) {
  return target && typeof target[name] === "function" ? target[name]() : null;
}

function titlePathFromParents(test) {
  const titles = [];
  let current = test;

  while (current) {
    if (current.title) {
      titles.unshift(String(current.title));
    }

    current = current.parent;
  }

  return titles;
}

function getTitlePath(test) {
  const titlePath = valueFromFunction(test, "titlePath");

  if (Array.isArray(titlePath) && titlePath.length > 0) {
    return titlePath.map(String);
  }

  return titlePathFromParents(test);
}

function getFullTitle(test) {
  const fullTitle = valueFromFunction(test, "fullTitle");

  if (fullTitle) {
    return String(fullTitle);
  }

  return getTitlePath(test).join(" ");
}

function getLocationFile(test) {
  let current = test;

  while (current) {
    if (current.file) {
      return String(current.file);
    }

    current = current.parent;
  }

  return null;
}

function getTestKey(test) {
  return `${getLocationFile(test) || ""}\u0000${getFullTitle(test)}`;
}

function durationInNanoseconds(test, startedAt, finishedAt) {
  if (
    typeof test.duration === "number" &&
    Number.isFinite(test.duration) &&
    test.duration >= 0
  ) {
    return Math.round(test.duration * 1000000);
  }

  if (startedAt && finishedAt) {
    return Math.max(0, finishedAt.getTime() - startedAt.getTime()) * 1000000;
  }

  return null;
}

function messageFromError(error) {
  if (!error) {
    return undefined;
  }

  if (typeof error.message === "string") {
    return error.message;
  }

  if (typeof error.inspect === "function") {
    return String(error.inspect());
  }

  return String(error);
}

function exceptionFromError(error) {
  if (!error) {
    return undefined;
  }

  if (typeof error.name === "string" && error.name.length > 0) {
    return error.name;
  }

  if (error.constructor && error.constructor.name) {
    return error.constructor.name;
  }

  return undefined;
}

function backtraceFromError(error, message, exception) {
  if (!error || typeof error.stack !== "string") {
    return [];
  }

  return error.stack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index) => {
      if (line.length === 0) {
        return true;
      }

      if (
        index === 0 &&
        message &&
        (line === message || line === `${exception}: ${message}`)
      ) {
        return false;
      }

      return true;
    });
}

function createStatus(kind, error) {
  if (kind === "successful") {
    return { kind: "successful" };
  }

  if (kind === "skipped") {
    return { kind: "skipped" };
  }

  const message = messageFromError(error);
  const exception = exceptionFromError(error);
  const backtrace = backtraceFromError(error, message, exception);
  const status = { kind: "failed" };

  if (exception) {
    status.exception = exception;
  }

  if (message) {
    status.message = message;
  }

  if (backtrace.length > 0) {
    status.backtrace = backtrace;
  }

  return status;
}

function stdoutFromTest(test) {
  if (Array.isArray(test.consoleOutputs) && test.consoleOutputs.length > 0) {
    return test.consoleOutputs.join("\n");
  }

  if (typeof test.stdout === "string" && test.stdout.length > 0) {
    return test.stdout;
  }

  return undefined;
}

function stderrFromTest(test) {
  if (Array.isArray(test.consoleErrors) && test.consoleErrors.length > 0) {
    return test.consoleErrors.join("\n");
  }

  if (typeof test.stderr === "string" && test.stderr.length > 0) {
    return test.stderr;
  }

  return undefined;
}

function screenshotMeta(screenshotPath) {
  return { screenshot: { image: screenshotPath } };
}

// The only writer of `attempt.meta`. Merges key by key so no contributor can
// clobber another's, and leaves `attempt.meta` undefined when nothing is added.
// Incoming wins on a shared key: the attachments hook runs after the reporter's
// own discovery, so a screenshot it supplies takes precedence.
function mergeAttemptMeta(attempt, meta) {
  if (!meta || !meta.screenshot) {
    return;
  }

  attempt.meta = attempt.meta || {};
  attempt.meta.screenshot = { ...attempt.meta.screenshot, ...meta.screenshot };
}

function createAttempt(test, kind, error, context = {}) {
  const attempt = {
    durationInNanoseconds: durationInNanoseconds(
      test,
      context.startedAt,
      context.finishedAt,
    ),
    status: createStatus(kind, error),
  };
  const stdout = stdoutFromTest(test);
  const stderr = stderrFromTest(test);

  if (context.screenshot) {
    mergeAttemptMeta(attempt, screenshotMeta(context.screenshot));
  }

  if (stdout) {
    attempt.stdout = stdout;
  }

  if (stderr) {
    attempt.stderr = stderr;
  }

  if (context.startedAt) {
    attempt.startedAt = context.startedAt.toISOString();
  }

  if (context.finishedAt) {
    attempt.finishedAt = context.finishedAt.toISOString();
  }

  return attempt;
}

function createTest(test, attempts, specFile) {
  const titlePath = getTitlePath(test);
  const name = getFullTitle(test);
  // Consumers template the spec path out of `location`, so never omit it.
  const locationFile = getLocationFile(test) || specFile || null;
  const finalAttempt = attempts[attempts.length - 1];
  const result = {
    name,
    lineage: titlePath,
    attempt: finalAttempt,
  };

  if (locationFile) {
    result.location = { file: locationFile };
  }

  if (attempts.length > 1) {
    result.pastAttempts = attempts.slice(0, -1);
  }

  return result;
}

function isFlaky(test) {
  const attempts = [...(test.pastAttempts || []), test.attempt];
  const hasSuccess = attempts.some(
    (attempt) => attempt.status.kind === "successful",
  );
  const hasFailure = attempts.some((attempt) =>
    ["failed", "timedOut"].includes(attempt.status.kind),
  );

  return hasSuccess && hasFailure;
}

function createSummary(tests, otherErrors) {
  const summary = {
    status: { kind: "successful" },
    tests: tests.length,
    otherErrors: otherErrors.length,
    retries: tests.filter(
      (test) => test.pastAttempts && test.pastAttempts.length > 0,
    ).length,
    canceled: 0,
    failed: 0,
    pended: 0,
    quarantined: 0,
    skipped: 0,
    successful: 0,
    timedOut: 0,
    todo: 0,
    flaky: tests.filter(isFlaky).length,
  };

  for (const test of tests) {
    const kind = test.attempt.status.kind;

    if (Object.prototype.hasOwnProperty.call(summary, kind)) {
      summary[kind] += 1;
    }
  }

  if (summary.failed > 0 || summary.canceled > 0 || otherErrors.length > 0) {
    summary.status = { kind: "failed" };
  } else if (summary.timedOut > 0) {
    summary.status = { kind: "timedOut" };
  }

  return summary;
}

function createResults(tests, otherErrors = []) {
  return {
    $schema:
      "https://raw.githubusercontent.com/rwx-research/test-results-schema/main/v1.json",
    framework: {
      language: "JavaScript",
      kind: "Cypress",
    },
    summary: createSummary(tests, otherErrors),
    tests,
    otherErrors,
  };
}

module.exports = {
  createAttempt,
  createResults,
  createTest,
  getFullTitle,
  getLocationFile,
  getTestKey,
  getTitlePath,
  mergeAttemptMeta,
  screenshotMeta,
};
