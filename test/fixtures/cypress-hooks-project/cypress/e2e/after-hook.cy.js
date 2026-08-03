describe("after fails", () => {
  after(() => expect("after").to.equal("broken"));
  it("passes", () => expect(true).to.equal(true));
});
