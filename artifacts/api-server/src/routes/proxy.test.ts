import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHIPS_UPSTREAM_URL } from "./proxy";

test("DEFAULT_SHIPS_UPSTREAM_URL points to the new Render backend", () => {
  assert.equal(
    DEFAULT_SHIPS_UPSTREAM_URL,
    "https://worldview-intel-ihsu.onrender.com"
  );
});
