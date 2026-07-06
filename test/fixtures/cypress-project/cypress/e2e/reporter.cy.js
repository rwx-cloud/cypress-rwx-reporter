let attempts = 0;

describe("rwx reporter integration", () => {
  it("passes", () => {
    expect(true).to.equal(true);
  });

  it("retries with a screenshot", { retries: 1 }, () => {
    attempts += 1;

    expect(attempts).to.equal(2);
  });
});
