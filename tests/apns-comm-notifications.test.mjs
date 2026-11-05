// apns-comm-notifications.test.mjs — the communication-notification switch.
// A push carries `mutable-content` (so the app's NotificationService extension
// upcasts it into a message from the assistant) unless the kill-switch file
// data/.comm-notifications-off exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commNotificationsOn } from "../lib/apns-push.mjs";

test("on by default, off while the kill-switch file exists", () => {
  const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comm-")), ".comm-notifications-off");
  assert.equal(commNotificationsOn(flag), true);
  fs.writeFileSync(flag, "");
  assert.equal(commNotificationsOn(flag), false);
});

test("the payload builder sets mutable-content only behind the switch", () => {
  const src = fs.readFileSync(new URL("../lib/apns-push.mjs", import.meta.url), "utf8");
  assert.ok(src.includes('if (commNotificationsOn()) aps["mutable-content"] = 1;'));
});
