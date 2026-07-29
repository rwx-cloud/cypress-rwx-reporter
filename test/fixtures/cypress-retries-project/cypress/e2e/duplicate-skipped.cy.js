// Two skipped tests sharing a title, with a test that runs between them. Cypress
// reports a skipped test before it would have started it, and closes the window
// on the test that did run — so the second skip arrives with nothing in flight
// and a record for its title already written. Merging them there is how two
// skipped tests came to look like one test that retried.
describe("duplicate skipped", () => {
  it.skip("shares a title", () => {});

  it("runs between them", () => {
    expect(true).to.equal(true);
  });

  it.skip("shares a title", () => {});
});
