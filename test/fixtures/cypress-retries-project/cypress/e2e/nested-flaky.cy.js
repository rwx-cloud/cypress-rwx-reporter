let tries = 0;

// Deliberately different per attempt, and separated by more than any plausible
// scheduling noise, so an attempt reporting the previous attempt's duration
// cannot pass for its own.
const WAITS = [1500, 500, 100];

// Succeeds only on the last attempt, nested two suites deep, so the merged
// record has to keep its lineage and end up successful rather than failed.
describe("nested outer", { retries: 2 }, () => {
  describe("nested inner", () => {
    it("passes on the third attempt", () => {
      cy.wait(WAITS[tries]);

      tries += 1;

      // Enqueued rather than thrown here, so the wait above is part of the
      // attempt rather than skipped by an immediate failure.
      cy.then(() => {
        expect(tries).to.equal(3);
      });
    });
  });
});
