// Body fails AND the afterEach fails: two failures for one test.
describe("body and hook both fail", () => {
  afterEach(() => expect("afterEach").to.equal("broken"));
  it("fails its body", () => expect(1).to.equal(2));
});
