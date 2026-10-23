import test from "node:test";
import assert from "node:assert/strict";
import { requestSitePermissionFromClick, requestTabsPermissionFromClick } from "../src/tab-permissions.js";

test("the follow toggle requests tabs only when the optional permission is not granted", async () => {
  const requests = [];
  const permissions = { request(details) { requests.push(details); return Promise.resolve(true); } };

  assert.equal(requestTabsPermissionFromClick({ tabsPermissionGranted: true }, permissions), null);
  assert.equal(requests.length, 0);
  assert.equal(await requestTabsPermissionFromClick({ tabsPermissionGranted: false }, permissions), true);
  assert.deepEqual(requests, [{ permissions: ["tabs"] }]);
});

test("site access requests only the active page origin and never requests for a missing or granted context", async () => {
  const requests = [];
  const permissions = { request(details) { requests.push(details); return Promise.resolve(false); } };
  const context = {
    url: "https://reader.example.com/article?session=private",
    hostPattern: "https://reader.example.com/*",
    sitePermissionGranted: false
  };

  assert.equal(await requestSitePermissionFromClick(context, permissions), false);
  assert.deepEqual(requests, [{ origins: ["https://reader.example.com/*"] }]);
  assert.equal(requestSitePermissionFromClick({ ...context, sitePermissionGranted: true }, permissions), null);
  assert.equal(requestSitePermissionFromClick({ hostPattern: context.hostPattern }, permissions), null);
  assert.equal(requests.length, 1);
});
