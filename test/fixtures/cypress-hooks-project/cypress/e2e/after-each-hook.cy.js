describe("afterEach fails", () => {
  afterEach(() => expect("afterEach").to.equal("broken"));
  it("passes its body", () => {
    expect(true).to.equal(true);
  });
});
