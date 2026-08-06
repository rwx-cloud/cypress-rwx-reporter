// Fails on every invocation, so a second Cypress process writes a second
// screenshot for the same test alongside the first one.
describe("without trashing", () => {
  it("fails with a screenshot", () => {
    expect(1).to.equal(2);
  });
});
