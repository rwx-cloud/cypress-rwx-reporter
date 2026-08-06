// A title long enough that Cypress's filename limit severs the ` (attempt N)`
// suffix, so all three attempts share a base name and Cypress separates their
// screenshots by collision number instead. The reporter has to walk those
// numbers to keep each attempt on its own image.
const longTitle = "t".repeat(300);

describe("long title", { retries: 2 }, () => {
  it(longTitle, () => {
    expect(1).to.equal(2);
  });
});
