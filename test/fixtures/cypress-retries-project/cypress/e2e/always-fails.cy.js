// Cypress-level retries on a test that fails every attempt. The reporter used
// to emit an extra, location-less record for such a test; see the reporter's
// handling of degraded `retry` events.

let attempt = 0;

// Deliberately different per attempt, and separated by more than any plausible
// scheduling noise, so an attempt reporting the previous attempt's duration
// cannot pass for its own.
const WAITS = [1500, 500, 100];

describe("retries to exhaustion", { retries: 2 }, () => {
  it("passes", () => {
    expect(true).to.equal(true);
  });

  it("always fails", () => {
    cy.wait(WAITS[attempt]);

    attempt += 1;

    // Enqueued rather than thrown here, so the wait above is part of the
    // attempt rather than skipped by an immediate failure.
    cy.then(() => {
      expect(1).to.equal(2);
    });
  });
});
