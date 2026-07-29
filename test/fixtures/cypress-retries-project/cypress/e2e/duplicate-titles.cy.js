// Mocha allows two tests to share a full title. They are still two tests, and
// merging them made a plain failure read as a flaky retry of the passing one.
describe("duplicate titles", { retries: 2 }, () => {
  it("shares a title", () => {
    expect(true).to.equal(true);
  });

  it("shares a title", () => {
    expect(1).to.equal(2);
  });
});
