// A hook that fails on every attempt. The suite opts into retries, since the
// project runs with them off.
describe("retried beforeEach", { retries: 2 }, () => {
  beforeEach(() => expect("hook").to.equal("broken"));
  it("never runs", () => expect(true).to.equal(true));
  it("also never runs", () => expect(true).to.equal(true));
});
