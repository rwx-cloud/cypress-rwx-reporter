describe("no hooks", () => {
  it("passes", () => expect(true).to.equal(true));
  it("fails its body", () => expect(1).to.equal(2));
});
