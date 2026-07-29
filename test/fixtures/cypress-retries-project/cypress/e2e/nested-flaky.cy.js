let tries = 0;

// Succeeds only on the last attempt, nested two suites deep, so the merged
// record has to keep its lineage and end up successful rather than failed.
describe("nested outer", { retries: 2 }, () => {
  describe("nested inner", () => {
    it("passes on the third attempt", () => {
      tries += 1;

      expect(tries).to.equal(3);
    });
  });
});
