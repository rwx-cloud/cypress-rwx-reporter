#!/usr/bin/env node
"use strict";

// Releases are published by hand. This script owns the checks a person
// forgets: that the tree matches what ships, that the manifest and the lockfile
// agree, that the version is not already gone, and that the published commit
// ends up tagged.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const RELEASE_BRANCH = "main";
const PUBLISHER = "rwx-bot";
// npm packs these no matter what the `files` allowlist says, so they are
// expected on top of whatever the allowlist adds.
const ALWAYS_PACKED = ["package.json", "README.md", "LICENSE"];
const RELEASE_TYPES = ["major", "minor", "patch"];
const MIN_NPM = "11.5.1";

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
}

function output(command, args) {
  const result = run(command, args);

  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new Error(`\`${command} ${args.join(" ")}\` failed: ${detail}`);
  }

  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

// Sleep without pulling the whole script into async, so the steps read in the
// order they run.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function confirm(question) {
  if (!process.stdin.isTTY) {
    fail("Not a terminal. Pass --yes to skip the confirmation.");
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

const problems = [];

function check(description, verify) {
  let problem;

  try {
    problem = verify();
  } catch (error) {
    problem = error.message;
  }

  if (problem) {
    problems.push(problem);
    console.log(`  ✗ ${description}`);
    console.log(`      ${problem.replace(/\n/g, "\n      ")}`);
    return;
  }

  console.log(`  ✓ ${description}`);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);

  for (let part = 0; part < 3; part += 1) {
    if ((a[part] || 0) !== (b[part] || 0)) {
      return (a[part] || 0) - (b[part] || 0);
    }
  }

  return 0;
}

// mise reads .tool-versions natively, so it stays the single source of truth —
// `rwx/tool-versions` parses the same file to build the CI matrix.
function pinnedNode() {
  const contents = fs.readFileSync(path.join(ROOT, ".tool-versions"), "utf8");

  for (const line of contents.split("\n")) {
    const [tool, version] = line.trim().split(/\s+/);

    if (tool === "nodejs" || tool === "node") {
      return version;
    }
  }

  return null;
}

function toolchainProblem() {
  const pinned = pinnedNode();

  if (!pinned) {
    return "no nodejs entry in .tool-versions";
  }

  if (process.versions.node !== pinned) {
    return `running Node ${process.versions.node}, .tool-versions pins ${pinned}; run \`mise install\``;
  }

  const npmVersion = output("npm", ["--version"]);

  if (compareVersions(npmVersion, MIN_NPM) < 0) {
    return `npm ${npmVersion} is older than ${MIN_NPM}`;
  }
}

function currentBranch() {
  return output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function dirtyFiles() {
  return output("git", ["status", "--porcelain"]);
}

function packedFiles() {
  const result = run("npm", ["pack", "--dry-run", "--json"]);

  if (result.status !== 0) {
    throw new Error(`\`npm pack\` failed: ${(result.stderr || "").trim()}`);
  }

  const [tarball] = JSON.parse(result.stdout);
  return tarball.files.map((file) => file.path);
}

function prepare(releaseType) {
  if (!RELEASE_TYPES.includes(releaseType)) {
    fail(`Usage: node scripts/release.js prepare <${RELEASE_TYPES.join("|")}>`);
  }

  const branch = currentBranch();

  if (branch === RELEASE_BRANCH) {
    fail(`On ${RELEASE_BRANCH}. The bump belongs on a branch, so it lands through a PR.`);
  }

  if (dirtyFiles()) {
    fail("Working tree is not clean. Commit or stash first, so the bump is the only change.");
  }

  const toolchain = toolchainProblem();

  if (toolchain) {
    fail(`Toolchain: ${toolchain}`);
  }

  // --no-git-tag-version deliberately: the tag belongs on the commit that ends
  // up on main after review, not on this branch.
  output("npm", ["version", releaseType, "--no-git-tag-version"]);

  const { version } = readJson("package.json");

  console.log(`Bumped to ${version} in package.json and package-lock.json.`);
  console.log("Commit it, open a PR, and merge once CI is green. Then:");
  console.log("  node scripts/release.js publish");
}

async function publish(options) {
  const manifest = readJson("package.json");
  const { name, version } = manifest;
  const tag = `v${version}`;

  try {
    output("git", ["fetch", "--quiet", "origin", RELEASE_BRANCH, "--tags"]);
  } catch (error) {
    fail(`Could not reach origin: ${error.message}`);
  }

  console.log(`Checking ${name}@${version}\n`);

  check("toolchain matches .tool-versions", toolchainProblem);

  check(`on ${RELEASE_BRANCH}`, () => {
    const branch = currentBranch();

    if (branch !== RELEASE_BRANCH) {
      return `on ${branch}; releases publish from ${RELEASE_BRANCH}`;
    }
  });

  check("working tree clean", () => {
    const dirty = dirtyFiles();

    if (dirty) {
      const listed = dirty.split("\n").map((line) => line.trim()).join("\n");
      return `these would ship as-is:\n${listed}`;
    }
  });

  check(`up to date with origin/${RELEASE_BRANCH}`, () => {
    const local = output("git", ["rev-parse", "HEAD"]);
    const remote = output("git", ["rev-parse", `origin/${RELEASE_BRANCH}`]);

    if (local !== remote) {
      return `HEAD is ${local.slice(0, 8)}, origin/${RELEASE_BRANCH} is ${remote.slice(0, 8)}`;
    }
  });

  check("package.json and package-lock.json agree on the version", () => {
    const lock = readJson("package-lock.json");
    const versions = new Set([version, lock.version, lock.packages[""].version]);

    if (versions.size !== 1) {
      return `package.json ${version}, package-lock.json ${lock.version} / ${lock.packages[""].version}`;
    }
  });

  check(`${tag} is free`, () => {
    if (run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).status === 0) {
      return `${tag} already exists locally`;
    }

    if (output("git", ["ls-remote", "--tags", "origin", tag])) {
      return `${tag} already exists on origin`;
    }
  });

  check(`${version} is not on the registry`, () => {
    const result = run("npm", ["view", `${name}@${version}`, "version"]);

    if (result.status === 0 && result.stdout.trim()) {
      return `${name}@${version} is already published; bump again`;
    }
  });

  check(`logged in to npm as ${PUBLISHER}`, () => {
    const result = run("npm", ["whoami"]);

    if (result.status !== 0) {
      return "not logged in; run `npm login` (the session lasts two hours)";
    }

    const user = result.stdout.trim();

    if (user !== PUBLISHER) {
      return `logged in as ${user}, not ${PUBLISHER}`;
    }
  });

  check("tarball holds exactly the tracked package files", () => {
    const packed = packedFiles();
    const tracked = output("git", ["ls-files", "index.js", "lib"]).split("\n").filter(Boolean);
    const expected = new Set([...ALWAYS_PACKED, ...tracked]);

    const extra = packed.filter((file) => !expected.has(file));
    const missing = [...expected].filter((file) => !packed.includes(file));

    if (extra.length) {
      return `these slipped past the \`files\` allowlist: ${extra.join(", ")}`;
    }

    if (missing.length) {
      return `these are tracked but would not ship: ${missing.join(", ")}`;
    }
  });

  if (problems.length) {
    fail(`${problems.length} check(s) failed. Nothing published.`);
  }

  if (options.skipCi) {
    console.log("\nSkipping CI (--skip-ci).");
  } else {
    console.log("\nRunning the full suite in RWX...\n");
    const result = run("rwx", ["run", ".rwx/ci.yml", "--wait"], { stdio: "inherit" });

    if (result.error) {
      fail(`Could not run the rwx CLI (${result.error.code}). Install it, or pass --skip-ci if the merge commit is already green.`);
    }

    if (result.status !== 0) {
      fail("CI failed. Nothing published.");
    }
  }

  if (options.dryRun) {
    // The checks above are ours; this is npm's own account of what it would send.
    console.log("\nAsking npm what it would publish...\n");

    const rehearsal = run("npm", ["publish", "--dry-run"], { stdio: "inherit" });

    if (rehearsal.status !== 0) {
      fail("`npm publish --dry-run` failed.");
    }

    console.log(`\nEvery check passed. Rerun without --dry-run to publish ${version}.`);
    return;
  }

  const sha = output("git", ["rev-parse", "HEAD"]);

  if (!options.yes && !(await confirm(`\nPublish ${name}@${version} from ${sha.slice(0, 8)}?`))) {
    fail("Aborted. Nothing published.");
  }

  console.log("");
  const published = run("npm", ["publish"], { stdio: "inherit" });

  if (published.status !== 0) {
    fail("`npm publish` failed. No tag written.");
  }

  if (!onRegistry(name, version)) {
    fail(`Published, but the registry does not report ${version} yet. Confirm with \`npm view ${name} version\`, then tag ${sha} as ${tag} by hand.`);
  }

  // Tag only once the publish has landed, so a failed publish never leaves a
  // tag claiming a release that does not exist.
  try {
    output("git", ["tag", "-a", tag, "-m", tag]);
    output("git", ["push", "origin", tag]);
  } catch (error) {
    fail(`Published ${version}, but tagging failed: ${error.message}\nTag ${sha} as ${tag} by hand.`);
  }

  console.log(`\nPublished ${name}@${version} and pushed ${tag} (${sha.slice(0, 8)}).`);
}

function onRegistry(name, version) {
  // The registry can lag the publish by a few seconds.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = run("npm", ["view", `${name}@${version}`, "version"]);

    if (result.status === 0 && result.stdout.trim() === version) {
      return true;
    }

    sleep(3000);
  }

  return false;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "prepare") {
    prepare(rest[0]);
    return;
  }

  if (command === "publish") {
    await publish({
      dryRun: rest.includes("--dry-run"),
      skipCi: rest.includes("--skip-ci"),
      yes: rest.includes("--yes"),
    });
    return;
  }

  fail(
    [
      "Usage:",
      `  node scripts/release.js prepare <${RELEASE_TYPES.join("|")}>`,
      "  node scripts/release.js publish [--dry-run] [--skip-ci] [--yes]",
    ].join("\n"),
  );
}

main().catch((error) => fail(error.stack));
