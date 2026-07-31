// Two failing tests in one spec. Each retry sequence has to stay with its own
// test; the reporter once orphaned one record per retried failure.
describe("two failures", { retries: 2 }, () => {
  it("fails first", () => {
    expect(1).to.equal(2);
  });

  it("fails second", () => {
    expect(3).to.equal(4);
  });
});
