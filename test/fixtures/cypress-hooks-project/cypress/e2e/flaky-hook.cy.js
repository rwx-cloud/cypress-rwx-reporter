// A hook that fails once and then succeeds. Cypress retries, the test passes,
// and its own summary calls this run green.
let attempts = 0;

describe("flaky beforeEach", { retries: 2 }, () => {
  beforeEach(() => {
    attempts += 1;

    if (attempts === 1) {
      expect("hook").to.equal("broken");
    }
  });

  it("passes on the second attempt", () => expect(true).to.equal(true));
});
