const fs = require("node:fs");
const path = require("node:path");
const sanitize = require("sanitize-filename");
const { getLocationFile, getTitlePath } = require("./results");

// Every name here mirrors a Cypress convention, not the RWX schema.
const RUNNABLE_SEPARATOR = " -- ";
const PATH_SEPARATOR = /[\\/]/g;
const DEFAULT_MAX_SAFE_FILENAME_BYTES = 254;

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

function screenshotBaseName(runnable, attemptNumber) {
  const titles = getTitlePath(runnable).map(sanitizeToString);
  let name = `${titles.join(RUNNABLE_SEPARATOR)} (failed)`;

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

function findExistingScreenshotPath(
  directory,
  filenames,
  baseName,
  collisionNumber,
) {
  const filename = screenshotFilename(baseName, collisionNumber);

  return filenames.has(filename) ? path.join(directory, filename) : null;
}

function findMatchingScreenshot(directory, baseName, attemptNumber) {
  if (!fs.existsSync(directory)) {
    return null;
  }

  const filenames = new Set(fs.readdirSync(directory));

  if (attemptNumber <= 1) {
    const exactPath = findExistingScreenshotPath(
      directory,
      filenames,
      baseName,
      0,
    );

    if (exactPath) {
      return exactPath;
    }
  }

  for (
    let collisionNumber = 1;
    collisionNumber <= filenames.size;
    collisionNumber += 1
  ) {
    const collisionPath = findExistingScreenshotPath(
      directory,
      filenames,
      baseName,
      collisionNumber,
    );

    if (collisionPath) {
      return collisionPath;
    }
  }

  return findExistingScreenshotPath(directory, filenames, baseName, 0);
}

function findFailureScreenshot(
  runnable,
  attemptNumber,
  options = {},
  projectRoot = process.cwd(),
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
  const baseName = screenshotBaseName(runnable, attemptNumber);
  const specParts = relativeSpec.split(PATH_SEPARATOR).filter(Boolean);
  const directories = specParts.map((_, index) =>
    path.join(screenshotsRoot, ...specParts.slice(index)),
  );

  for (const directory of directories) {
    const found = findMatchingScreenshot(directory, baseName, attemptNumber);

    if (found) {
      return path.resolve(found);
    }
  }

  return null;
}

module.exports = {
  findFailureScreenshot,
  screenshotFilename,
};
