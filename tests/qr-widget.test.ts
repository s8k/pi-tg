import { test } from "node:test";
import assert from "node:assert/strict";
import { qrWidgetFactory, renderQr } from "../src/onboarding.ts";

// pi's InteractiveMode caps *array* widget content at MAX_WIDGET_LINES = 10
// and appends "... (widget truncated)". A 25×25 QR renders as 27 lines, so the
// extension must pass the component-factory form of setWidget instead.

test("qrWidgetFactory: factory form escapes pi's 10-line array-widget cap", () => {
  const qr = renderQr("https://t.me/pi_telega_bot");
  const lines = qr.split("\n");
  assert.ok(lines.length > 10, "precondition: QR is taller than pi's widget cap");

  const factory = qrWidgetFactory(qr);
  assert.equal(typeof factory, "function", "must be a component factory — string[] widgets get truncated");

  const comp = factory(null, null);
  const rendered = comp.render(120);
  assert.deepEqual(rendered, lines, "full QR, untruncated");
  comp.invalidate(); // must not throw
});

test("qrWidgetFactory: output ends with the quiet-zone pad line, not a truncation marker", () => {
  const qr = renderQr("https://t.me/pi_telega_bot");
  const comp = qrWidgetFactory(qr)(null, null);
  const rendered = comp.render(120);
  assert.ok(!rendered.join("\n").includes("widget truncated"));
  assert.equal(rendered[rendered.length - 1].trim(), "");
  // bottom quiet zone: the last module row must be present and scannable
  assert.ok(rendered[rendered.length - 2].includes("█"));
});
