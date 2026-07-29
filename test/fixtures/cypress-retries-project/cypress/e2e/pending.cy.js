// Cypress reports these without opening a `test`/`test end` window, which is
// the path where the reporter has no in-flight test to attribute an event to.
describe("pending shapes", () => {
  it("has no body");

  it.skip("is explicitly skipped", () => {
    expect(true).to.equal(true);
  });

  it("runs normally", () => {
    expect(true).to.equal(true);
  });
});

describe.skip("skipped suite", () => {
  it("is inside a skipped suite", () => {
    expect(true).to.equal(true);
  });
});
