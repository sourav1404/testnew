import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uncoveredQty } from "../src/views/Sales.jsx";

/**
 * The one piece of arithmetic the console does itself, so it gets its own test.
 * Quantities arrive as numeric(14,4) strings; doing this in float would undo
 * the reason the backend keeps them as strings at all.
 */
describe("uncoveredQty: ordered - shipped - held, exactly", () => {
  const cases: Array<[string, string, string, string, string]> = [
    ["8", "0", "5", "3.0000", "5 held of 8, nothing shipped"],
    ["8", "5", "0", "3.0000", "5 shipped, hold consumed"],
    ["8", "5", "3", "0.0000", "5 shipped and 3 held: fully covered"],
    ["8", "8", "0", "0.0000", "fully shipped"],
    ["0.3", "0.1", "0.1", "0.1000", "fractional quantities stay exact"],
    ["1", "0", "0", "1.0000", "nothing covered yet"],
    ["5", "5", "5", "0.0000", "never negative, even if the inputs disagree"],
  ];
  for (const [qty, shipped, held, want, why] of cases) {
    it(`${qty} - ${shipped} - ${held} = ${want} (${why})`, () => {
      assert.equal(uncoveredQty(qty, shipped, held), want);
    });
  }

  it("does not drift the way float subtraction would", () => {
    // 0.3 - 0.1 - 0.1 in float is 0.09999999999999999
    assert.equal(uncoveredQty("0.3", "0.1", "0.1"), "0.1000");
    assert.notEqual(String(0.3 - 0.1 - 0.1), "0.1");
  });
});
