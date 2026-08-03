// `after all` attaches to the last test that ran. Do the earlier ones still pass?
describe("after all fails, several tests", () => {
  after(() => expect("after").to.equal("broken"));
  it("first passes", () => expect(true).to.equal(true));
  it("second passes", () => expect(true).to.equal(true));
});
