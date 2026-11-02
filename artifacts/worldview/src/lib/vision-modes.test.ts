import test from "node:test";
import assert from "node:assert/strict";
import { styleReady } from "./vision-modes";

test("styleReady returns true as soon as map style layers array exists even while sources stream", () => {
  const fakeMapReady = {
    getStyle: () => ({ layers: [{ id: "background", type: "background" }] }),
    isStyleLoaded: () => false,
  } as any;
  assert.equal(styleReady(fakeMapReady), true);

  const fakeMapNotReady = {
    getStyle: () => undefined,
  } as any;
  assert.equal(styleReady(fakeMapNotReady), false);
});
