// Cypress-level retries on a test that fails every attempt. The reporter used
// to emit an extra, location-less record for such a test; see the reporter's
// handling of degraded `retry` events.
describe("retries to exhaustion", { retries: 2 }, () => {
  it("passes", () => {
    expect(true).to.equal(true);
  });

  it("always fails", () => {
    expect(1).to.equal(2);
  });
});
