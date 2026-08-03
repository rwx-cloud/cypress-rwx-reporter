// A failing beforeEach in an outer suite, with a nested suite below it.
describe("outer with broken beforeEach", () => {
  beforeEach(() => expect("hook").to.equal("broken"));
  it("outer never runs", () => expect(true).to.equal(true));
  describe("inner", () => {
    it("inner never runs", () => expect(true).to.equal(true));
  });
});
