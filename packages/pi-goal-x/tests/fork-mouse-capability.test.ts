import test from "node:test";
import assert from "node:assert/strict";
import { MouseCapabilityNotice } from "../extensions/widgets/fork-mouse-capability.ts";

test("仅可检测的普通模式按会话去重提示", () => {
  const notice = new MouseCapabilityNotice();
  const messages: string[] = [];
  const a = {},
    b = {};
  const notify = (s: string) => messages.push(s);
  notice.observe(undefined, a, notify);
  notice.observe("fullscreen", a, notify);
  notice.observe("regular", null, notify);
  assert.equal(messages.length, 0);
  notice.observe("regular", a, notify);
  notice.observe("regular", a, notify);
  notice.observe("regular", b, notify);
  assert.equal(messages.length, 2);
});
