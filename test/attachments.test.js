const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  callAttachmentsHook,
  isThenable,
  loadAttachmentsHook,
  validateAttachments,
} = require("../lib/attachments");

// A real directory with real files: the validator warns about paths that do
// not exist, so fake roots would add a warning to every case.
const projectRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "cypress-rwx-attachments-"),
);

fs.mkdirSync(path.join(projectRoot, "artifacts"), { recursive: true });
fs.mkdirSync(path.join(projectRoot, "elsewhere"), { recursive: true });
fs.writeFileSync(path.join(projectRoot, "artifacts/report.html"), "<html>");
fs.writeFileSync(path.join(projectRoot, "elsewhere/shot.png"), "png");

function fixture(name) {
  return path.join(__dirname, "fixtures", name);
}

function validate(value) {
  const warnings = [];
  const result = validateAttachments(
    value,
    (message) => {
      warnings.push(message);
    },
    projectRoot,
  );

  return { result, warnings };
}

function resolved(...segments) {
  return path.resolve(projectRoot, ...segments);
}

test("treats returning nothing as a silent no-op", () => {
  for (const value of [undefined, null, {}, { screenshot: {} }]) {
    const { result, warnings } = validate(value);

    assert.equal(result, null);
    assert.deepEqual(warnings, []);
  }
});

test("rejects return values that are not plain objects", () => {
  const cases = [
    [[{ name: "a", path: "b" }], /returned an array/],
    ["snapshot.html", /returned a string/],
    [42, /returned a number/],
  ];

  for (const [value, expected] of cases) {
    const { result, warnings } = validate(value);

    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], expected);
  }
});

test("drops unsupported top-level keys but keeps the screenshot", () => {
  const { result, warnings } = validate({
    logs: ["nope"],
    screenshot: { html: "artifacts/report.html" },
    video: "nope",
  });

  assert.deepEqual(result, {
    screenshot: { html: resolved("artifacts/report.html") },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported key\(s\) "logs", "video"/);
});

test("drops a screenshot that is not a plain object", () => {
  const { result, warnings } = validate({ screenshot: ["a.png"] });

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"screenshot" as an array/);
});

test("drops invalid screenshot values and unsupported screenshot keys", () => {
  const { result, warnings } = validate({
    screenshot: { html: "artifacts/report.html", image: 7, video: "a.mp4" },
  });

  assert.deepEqual(result, {
    screenshot: { html: resolved("artifacts/report.html") },
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /unsupported key\(s\) "video" on "screenshot"/);
  assert.match(warnings[1], /"screenshot.image" as a number/);
});

test("resolves relative screenshot paths against the project root", () => {
  const absolute = path.resolve(projectRoot, "elsewhere", "shot.png");
  const { result, warnings } = validate({
    screenshot: { html: "artifacts/report.html", image: absolute },
  });

  assert.deepEqual(warnings, []);
  assert.equal(result.screenshot.html, resolved("artifacts/report.html"));
  assert.equal(result.screenshot.image, absolute);
});

test("warns about a screenshot file that does not exist but keeps it", () => {
  const { result, warnings } = validate({
    screenshot: { html: "artifacts/written-later.html" },
  });

  // Kept, not dropped: the run may write it after the hook returns.
  assert.deepEqual(result, {
    screenshot: { html: resolved("artifacts/written-later.html") },
  });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /"screenshot.html" pointing at a file that does not exist/,
  );
});

test("returns null when nothing survives validation", () => {
  const { result, warnings } = validate({ screenshot: { html: "" } });

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
});

test("contains a hook that throws and reports it", () => {
  const warnings = [];
  const result = callAttachmentsHook(
    () => {
      throw new Error("boom");
    },
    [],
    (message) => warnings.push(message),
  );

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /attachmentsHook threw: Error: boom/);
});

test("contains a hook that throws before it returns a promise", async () => {
  const warnings = [];
  const result = callAttachmentsHook(
    () => {
      throw new Error("sync boom");
    },
    [],
    (message) => warnings.push(message),
  );

  assert.equal(result, null);
  assert.match(warnings[0], /attachmentsHook threw: Error: sync boom/);
});

test("recognises what the reporter can await", () => {
  const thenables = [
    Promise.resolve(),
    { then() {} },
    Object.assign(() => {}, { then() {} }),
  ];

  for (const value of thenables) {
    assert.equal(isThenable(value), true);
  }

  for (const value of [undefined, null, {}, 42, "then", [], () => {}]) {
    assert.equal(isThenable(value), false);
  }
});

test("treats an unset attachmentsHook as disabled", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(loadAttachmentsHook(value, projectRoot), null);
  }
});

test("rejects a non-string attachmentsHook", () => {
  assert.throws(
    () => loadAttachmentsHook(() => {}, projectRoot),
    /attachmentsHook must be a path to a JavaScript file, received a function/,
  );
});

test("loads a hook from an absolute or a relative path", () => {
  const absolute = fixture("attachments-hook.js");
  const relative = path.relative(__dirname, absolute);

  assert.equal(typeof loadAttachmentsHook(absolute, __dirname), "function");
  assert.equal(
    loadAttachmentsHook(relative, __dirname),
    loadAttachmentsHook(absolute, __dirname),
  );
});

test("loads a hook path without a file extension", () => {
  assert.equal(
    typeof loadAttachmentsHook("fixtures/attachments-hook", __dirname),
    "function",
  );
});

// Node decides ESM vs CJS from the package.json nearest the hook, not ours, so
// these fixtures carry their own `"type": "module"`. Both lean on Node's own
// support for requiring them, hence the version gates.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const requiresEsm =
  nodeMajor > 22 ||
  (nodeMajor === 22 && nodeMinor >= 12) ||
  (nodeMajor === 20 && nodeMinor >= 19);
const stripsTypes = nodeMajor >= 24 || (nodeMajor === 23 && nodeMinor >= 6);

test("loads an ES module hook", { skip: !requiresEsm }, () => {
  const hook = loadAttachmentsHook(
    fixture("esm-hooks/attachments.js"),
    __dirname,
  );

  assert.deepEqual(hook({}, "failed"), { screenshot: { html: "esm-failed" } });
});

test("loads a TypeScript hook", { skip: !stripsTypes }, () => {
  const hook = loadAttachmentsHook(
    fixture("esm-hooks/attachments.ts"),
    __dirname,
  );

  assert.deepEqual(hook({}, "failed"), { screenshot: { html: "ts-failed" } });
});

test("unwraps a transpiled default export", () => {
  const hook = loadAttachmentsHook(
    fixture("attachments-hook-default-export.js"),
    __dirname,
  );

  assert.equal(typeof hook, "function");
  assert.deepEqual(hook(), { screenshot: { html: "artifacts/report.html" } });
});

test("loads an async hook", async () => {
  const hook = loadAttachmentsHook(
    fixture("attachments-hook-async.js"),
    __dirname,
  );

  assert.deepEqual(await hook(), {
    screenshot: { html: "artifacts/report.html" },
  });
});

// `require` cannot load a module graph that awaits before it finishes.
test(
  "reports a hook module that awaits at the top level",
  { skip: !requiresEsm },
  () => {
    assert.throws(
      () =>
        loadAttachmentsHook(
          fixture("esm-hooks/attachments-await.js"),
          __dirname,
        ),
      /Could not load attachmentsHook .*top-level await/s,
    );
  },
);

test("reports a missing hook file", () => {
  assert.throws(
    () => loadAttachmentsHook("hooks/nope.js", projectRoot),
    /Could not load attachmentsHook "hooks\/nope\.js": no such file at/,
  );
});

test("surfaces an error thrown while loading the hook file", () => {
  assert.throws(
    () =>
      loadAttachmentsHook(fixture("attachments-hook-load-error.js"), __dirname),
    /load failure/,
  );
});

test("rejects a hook file that does not export a function", () => {
  assert.throws(
    () =>
      loadAttachmentsHook(
        fixture("attachments-hook-not-a-function.js"),
        __dirname,
      ),
    /must export a function/,
  );
});
