const fs = require("node:fs");
const path = require("node:path");
const sanitize = require("sanitize-filename");
const { getLocationFile, getTitlePath } = require("./results");

// Every name here mirrors a Cypress convention, not the RWX schema.
const RUNNABLE_SEPARATOR = " -- ";
const PATH_SEPARATOR = /[\\/]/g;
const DEFAULT_MAX_SAFE_FILENAME_BYTES = 254;
// This clock and the one that stamps a screenshot need not be the same: on a
// network-backed mount the server does the stamping, and its clock can sit
// slightly behind ours. Slack costs no discrimination, because a previous
// invocation's screenshots predate this one by a whole Cypress restart.
const INVOCATION_START_TOLERANCE_MS = 1000;

function specPath(locationFile, projectRoot) {
  if (!locationFile) {
    return null;
  }

  if (path.isAbsolute(locationFile)) {
    return path.relative(projectRoot, locationFile);
  }

  return locationFile;
}

function sanitizeToString(value) {
  return sanitize(value == null ? "" : String(value));
}

function maxSafeFilenameBytes() {
  return (
    Number(process.env.CYPRESS_MAX_SAFE_FILENAME_BYTES) ||
    DEFAULT_MAX_SAFE_FILENAME_BYTES
  );
}

// Cypress appends the hook as one more runnable:
// `<suite> -- <test> -- before each hook (failed).png`.
function screenshotBaseName(runnable, attemptNumber, hookName) {
  const titles = getTitlePath(runnable).map(sanitizeToString);
  const runnables = hookName
    ? [...titles, `${sanitizeToString(hookName)} hook`]
    : titles;
  let name = `${runnables.join(RUNNABLE_SEPARATOR)} (failed)`;

  if (attemptNumber > 1) {
    name = `${name} (attempt ${attemptNumber})`;
  }

  return name;
}

function screenshotFilename(baseName, collisionNumber = 0) {
  const suffix = `${collisionNumber ? ` (${collisionNumber})` : ""}.png`;
  const maxSafePrefixBytes = maxSafeFilenameBytes() - suffix.length;
  const filenameBuffer = Buffer.from(baseName);
  const prefix =
    filenameBuffer.byteLength > maxSafePrefixBytes
      ? filenameBuffer.slice(0, maxSafePrefixBytes).toString()
      : baseName;

  return `${prefix}${suffix}`;
}

// Every name Cypress could have given this attempt's screenshot, plain name
// first. Cypress numbers a collision from 1 and cannot have written more of them
// than there are files here.
function screenshotCandidates(filenames, baseName) {
  const candidates = [];

  for (
    let collisionNumber = 0;
    collisionNumber <= filenames.size;
    collisionNumber += 1
  ) {
    const filename = screenshotFilename(baseName, collisionNumber);

    if (filenames.has(filename)) {
      candidates.push({ collisionNumber, filename });
    }
  }

  return candidates;
}

function preferredScreenshot(candidates, attemptNumber) {
  const plain = candidates.find(({ collisionNumber }) => collisionNumber === 0);
  const collided = candidates.find(({ collisionNumber }) => collisionNumber > 0);

  // Cypress writes attempt 1 under the plain name. A later attempt only lands on
  // one when its own name was truncated past the ` (attempt N)` suffix, in which
  // case Cypress collided it with the earlier attempt's.
  return (attemptNumber <= 1 ? plain || collided : collided || plain) || null;
}

// Null when there is no usable epoch, which leaves every candidate eligible.
// `Number(null)` is 0, so the absent case has to be caught before the coercion.
function invocationStart(startedAt) {
  if (startedAt == null) {
    return null;
  }

  const time =
    startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);

  return Number.isFinite(time) ? time - INVOCATION_START_TOLERANCE_MS : null;
}

function writtenSince(directory, filename, since) {
  try {
    return fs.statSync(path.join(directory, filename)).mtimeMs >= since;
  } catch {
    // Gone from under us, so it is not this invocation's screenshot.
    return false;
  }
}

// Cypress only clears the screenshots folder when `trashAssetsBeforeRuns` is on.
// With it off, a previous invocation's screenshot for this same attempt still
// holds the plain name and Cypress writes this one beside it as a collision, so
// the name alone no longer says which invocation a file came from.
function findMatchingScreenshot(
  directory,
  baseName,
  attemptNumber,
  invocationStartedAt,
) {
  if (!fs.existsSync(directory)) {
    return null;
  }

  const filenames = new Set(fs.readdirSync(directory));
  const candidates = screenshotCandidates(filenames, baseName);
  const since = invocationStart(invocationStartedAt);
  const written =
    since === null
      ? candidates
      : candidates.filter(({ filename }) =>
          writtenSince(directory, filename, since),
        );
  const match =
    preferredScreenshot(written, attemptNumber) ||
    // Nothing here looks like this invocation wrote it, so there is nothing left
    // to tell the candidates apart. Timestamps we cannot trust should cost the
    // attempt that discrimination, never the screenshot itself.
    preferredScreenshot(candidates, attemptNumber);

  return match ? path.join(directory, match.filename) : null;
}

function locateScreenshot(
  runnable,
  attemptNumber,
  options,
  projectRoot,
  hookName,
  invocationStartedAt,
) {
  const locationFile = getLocationFile(runnable);
  const relativeSpec = specPath(options.specFile || locationFile, projectRoot);

  if (!relativeSpec) {
    return null;
  }

  const screenshotsFolder =
    options.screenshotsFolder ||
    process.env.CYPRESS_SCREENSHOTS_FOLDER ||
    "cypress/screenshots";
  const screenshotsRoot = path.isAbsolute(screenshotsFolder)
    ? screenshotsFolder
    : path.join(projectRoot, screenshotsFolder);
  const baseName = screenshotBaseName(runnable, attemptNumber, hookName);
  const specParts = relativeSpec.split(PATH_SEPARATOR).filter(Boolean);
  const directories = specParts.map((_, index) =>
    path.join(screenshotsRoot, ...specParts.slice(index)),
  );

  for (const directory of directories) {
    const found = findMatchingScreenshot(
      directory,
      baseName,
      attemptNumber,
      invocationStartedAt,
    );

    if (found) {
      return path.resolve(found);
    }
  }

  return null;
}

// `invocationStartedAt` is when this Cypress invocation began. Without it,
// screenshots a previous invocation left behind are indistinguishable from this
// one's.
function findFailureScreenshot(
  runnable,
  attemptNumber,
  options = {},
  projectRoot = process.cwd(),
  invocationStartedAt = null,
) {
  return locateScreenshot(
    runnable,
    attemptNumber,
    options,
    projectRoot,
    null,
    invocationStartedAt,
  );
}

function findHookFailureScreenshot(
  testRunnable,
  hookName,
  attemptNumber,
  options = {},
  projectRoot = process.cwd(),
  invocationStartedAt = null,
) {
  if (!testRunnable || !hookName) {
    return null;
  }

  return locateScreenshot(
    testRunnable,
    attemptNumber,
    options,
    projectRoot,
    hookName,
    invocationStartedAt,
  );
}

module.exports = {
  findFailureScreenshot,
  findHookFailureScreenshot,
  screenshotFilename,
};
