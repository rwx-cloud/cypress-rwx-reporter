describe("beforeEach fails", () => {
  beforeEach(() => expect("hook").to.equal("broken"));
  it("never runs", () => expect(true).to.equal(true));
  it("also never runs", () => expect(true).to.equal(true));
});
