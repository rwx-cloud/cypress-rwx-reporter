// Every attempt fails twice: once in the body, once in the afterEach. Cypress
// writes a screenshot per body failure and per hook failure.
describe("both fail every attempt", { retries: 2 }, () => {
  afterEach(() => expect("afterEach").to.equal("broken"));
  it("fails its body", () => expect(1).to.equal(2));
});
