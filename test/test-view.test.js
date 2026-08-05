const assert = require("node:assert/strict");
const test = require("node:test");
const { testView } = require("../lib/test-view");

// Mirrors what Cypress hands the reporter: attempt state on the instance, titles
// derived by methods on the prototype.
class FakeSuite {
  constructor(title, parent) {
    this.title = title;
    this.parent = parent;
    this.tests = [];
  }

  titlePath() {
    return this.parent ? this.parent.titlePath().concat([this.title]) : [];
  }
}

class FakeTest {
  constructor(title, parent) {
    this.title = title;
    this.parent = parent;
    this.state = undefined;
    this.err = undefined;
    this.duration = undefined;
    this._currentRetry = 0;
  }

  titlePath() {
    return this.parent.titlePath().concat([this.title]);
  }

  fullTitle() {
    return this.titlePath().join(" ");
  }

  currentRetry() {
    return this._currentRetry;
  }

  isFailed() {
    return this.state === "failed";
  }
}

function createTest() {
  const root = new FakeSuite("", null);
  const suite = new FakeSuite("checkout", root);
  const runnable = new FakeTest("submits", suite);

  suite.tests.push(runnable);

  return runnable;
}

// What Cypress carries on a `retry` event: no parent, no titles, and the retry
// counter as a number where the live test has a method — cypress-io/cypress#27732.
function createRetryEvent({ title, state, err, duration }) {
  return { title, state, err, duration, currentRetry: 2, retries: 2 };
}

test("reads the live test's own properties and titles", () => {
  const runnable = createTest();
  const { view } = testView(runnable);

  assert.equal(view.title, "submits");
  assert.equal(view.fullTitle(), "checkout submits");
  assert.deepEqual(view.titlePath(), ["checkout", "submits"]);
  assert.equal(view.parent.title, "checkout");
  assert.equal(view.parent.parent.title, "");
  assert.deepEqual(Object.keys(view), Object.keys(runnable));
});

test("takes the attempt's outcome from the event Cypress reported it with", () => {
  const runnable = createTest();

  // The live test through a retry: the previous attempt's state, and no error.
  runnable.state = "skipped";
  runnable.err = undefined;
  runnable.duration = undefined;

  const failure = new Error("first failure");
  const { view } = testView(
    runnable,
    createRetryEvent({
      title: "submits",
      state: "failed",
      err: failure,
      duration: 87,
    }),
  );

  assert.equal(view.state, "failed");
  assert.equal(view.duration, 87);
  assert.equal(view.isFailed(), true);
  assert.equal(view.err.message, "first failure");
  assert.ok(view.err instanceof Error);
});

test("keeps the live test's identity and retry counter through the overlay", () => {
  const runnable = createTest();

  runnable._currentRetry = 0;

  const { view } = testView(
    runnable,
    createRetryEvent({ title: "submits", state: "failed", duration: 87 }),
  );

  // Overlaying the event's number would cost the hook the method.
  assert.equal(typeof view.currentRetry, "function");
  assert.equal(view.currentRetry(), 0);
  assert.equal(view.fullTitle(), "checkout submits");
  assert.equal(view.parent.title, "checkout");
});

test("overlays only the test itself, not what is reachable below it", () => {
  const runnable = createTest();

  runnable.parent.state = "suite state";

  const { view } = testView(
    runnable,
    createRetryEvent({ title: "submits", state: "failed" }),
  );

  assert.equal(view.state, "failed");
  assert.equal(view.parent.state, "suite state");
});

test("leaves the view alone when the event carried the live test itself", () => {
  const runnable = createTest();

  runnable.state = "passed";
  runnable.duration = 8;

  const { view } = testView(runnable, runnable);

  assert.equal(view.state, "passed");
  assert.equal(view.duration, 8);
  assert.equal(view.currentRetry(), 0);
});

test("passes the error through as it is, rather than a copy", () => {
  const runnable = createTest();
  const failure = new TypeError("boom");

  runnable.err = failure;

  const { view } = testView(runnable);

  assert.equal(view.err.message, "boom");
  assert.ok(view.err instanceof TypeError);
  assert.ok(view.err.stack.includes("boom"));
});

test("refuses writes, wherever in the view they are aimed", () => {
  const runnable = createTest();
  const { view } = testView(runnable);

  assert.throws(() => {
    view.title = "hijacked";
  }, /may not modify "title"/);
  assert.throws(() => {
    delete view.err;
  }, /may not modify "err"/);
  assert.throws(() => {
    Object.defineProperty(view, "extra", { value: 1 });
  }, /may not modify "extra"/);

  assert.throws(() => {
    view.parent.title = "hijacked";
  }, /may not modify "title"/);

  assert.equal(runnable.title, "submits");
  assert.equal(runnable.parent.title, "checkout");
  assert.ok("err" in runnable);
});

test("refuses a write even after the view has expired", () => {
  const runnable = createTest();
  const { view, expire } = testView(runnable);

  expire();

  // A write was never the hook's to make, so it hears that rather than the expiry.
  assert.throws(() => {
    view.title = "hijacked";
  }, /may not modify "title"/);
  assert.equal(runnable.title, "submits");
});

test("refuses a read after the view has expired", () => {
  const runnable = createTest();
  const { view, expire } = testView(runnable);

  const title = view.fullTitle();

  expire();

  assert.equal(title, "checkout submits");
  assert.throws(
    () => view.state,
    /read "state" from the test object after awaiting.*before your first await/s,
  );
  assert.throws(() => view.fullTitle(), /read "fullTitle"/);
});

test("refuses a read through the suite chain after the view has expired", () => {
  const runnable = createTest();
  const { view, expire } = testView(runnable);
  const parent = view.parent;

  expire();

  assert.throws(() => parent.title, /read "title"/);
});

test("expires each invocation's view on its own", () => {
  const runnable = createTest();
  const first = testView(runnable);
  const second = testView(runnable);
  const firstParent = first.view.parent;
  const secondParent = second.view.parent;

  first.expire();

  // The suite is shared, so a cache spanning both would expire the second too.
  assert.throws(() => firstParent.title, /read "title"/);
  assert.equal(secondParent.title, "checkout");
  assert.equal(second.view.fullTitle(), "checkout submits");
});

test("reads a property the test locked down", () => {
  const runnable = createTest();

  // Unwrappable without breaking a proxy invariant, so it comes through raw.
  Object.defineProperty(runnable, "locked", {
    configurable: false,
    enumerable: true,
    value: { attempt: 1 },
    writable: false,
  });

  const { view } = testView(runnable);

  assert.equal(view.locked.attempt, 1);
  assert.throws(() => {
    view.locked = "hijacked";
  }, /may not modify "locked"/);
});

test("passes a non-object runnable through", () => {
  const { view, expire } = testView(null);

  assert.equal(view, null);
  assert.doesNotThrow(expire);
});
