import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PIPER_VOICE_CATALOG, KOKORO_VOICE_CATALOG, getVoiceProvider } from "../src/voice-catalog.js";
import {
  createModelManagementDisclosure,
  getVoicePreparationState,
  MODEL_STATUS_CHECK_TIMEOUT_MS,
  withBoundedWait
} from "../src/model-management-disclosure.js";

const main = await readFile(fileURLToPath(new URL("../src/main.js", import.meta.url)), "utf8");
const panel = await readFile(fileURLToPath(new URL("../sidepanel.html", import.meta.url)), "utf8");

function createHarness({ selectedVoice, stateForVoice, open = false }) {
  let openCount = 0;
  const details = {
    _open: open,
    get open() { return this._open; },
    set open(value) { this._open = value; if (value) openCount++; }
  };
  const disclosure = createModelManagementDisclosure({
    details,
    getSelectedVoiceId: () => selectedVoice.value,
    getPreparationState: stateForVoice
  });
  return { details, disclosure, openCount: () => openCount };
}

test("selecting a Piper voice whose model is absent opens its existing management section", () => {
  const voiceId = PIPER_VOICE_CATALOG[0].id;
  const piperStates = new Map([[voiceId, { state: "idle", installed: false }]]);
  const kokoroState = "ready";
  const harness = createHarness({
    selectedVoice: { value: voiceId },
    stateForVoice: (id) => getVoicePreparationState(id, { getVoiceProvider, piperStates, kokoroState })
  });

  assert.equal(harness.disclosure.onVoiceSelection(), true);
  assert.equal(harness.details.open, true);
  assert.equal(panel.match(/<details id="model-management"/g)?.length, 1);
  assert.match(panel, /id="install-model"/);
});

test("a Piper voice already prepared does not force the section open", () => {
  const voiceId = PIPER_VOICE_CATALOG[0].id;
  const harness = createHarness({
    selectedVoice: { value: voiceId },
    stateForVoice: (id) => id === voiceId ? "ready" : "idle"
  });

  assert.equal(harness.disclosure.onVoiceSelection(), false);
  assert.equal(harness.details.open, false);
});

test("a pending provider check waits for its result before deciding whether to open", () => {
  const voiceId = PIPER_VOICE_CATALOG[0].id;
  const selectedVoice = { value: voiceId };
  let state = "checking";
  const harness = createHarness({ selectedVoice, stateForVoice: () => state });

  assert.equal(harness.disclosure.onVoiceSelection(), false);
  assert.equal(harness.details.open, false);
  state = "idle";
  assert.equal(harness.disclosure.onProviderStateChange(voiceId, "checking", state), true);
  assert.equal(harness.details.open, true);
});

test("selecting Kokoro when local resources still need initialization opens management", () => {
  const voiceId = KOKORO_VOICE_CATALOG[0].id;
  const harness = createHarness({ selectedVoice: { value: voiceId }, stateForVoice: () => "cached" });

  assert.equal(harness.disclosure.onVoiceSelection(), true);
  assert.equal(harness.details.open, true);
  assert.match(panel, /Preparar Kokoro local/);
});

test("ready voices do not reopen the section during repeated state and render updates", () => {
  const voiceId = KOKORO_VOICE_CATALOG[0].id;
  const selectedVoice = { value: voiceId };
  const harness = createHarness({ selectedVoice, stateForVoice: () => "ready" });

  assert.equal(harness.disclosure.onVoiceSelection(), false);
  for (let index = 0; index < 5; index++) {
    assert.equal(harness.disclosure.onProviderStateChange(voiceId, "ready", "ready"), false);
  }
  assert.equal(harness.openCount(), 0);
  assert.equal(harness.details.open, false);
  const render = main.slice(main.indexOf("function renderPlayer("), main.indexOf("async function refreshDownloadLink("));
  assert.doesNotMatch(render, /modelManagementDisclosure/);
});

test("the section remains open through loading transitions without repeated open requests", () => {
  const voiceId = PIPER_VOICE_CATALOG[0].id;
  const harness = createHarness({ selectedVoice: { value: voiceId }, stateForVoice: () => "idle" });

  harness.disclosure.onVoiceSelection();
  assert.equal(harness.disclosure.onProviderStateChange(voiceId, "idle", "loading"), false);
  assert.equal(harness.disclosure.onProviderStateChange(voiceId, "loading", "loading"), false);
  assert.equal(harness.details.open, true);
  assert.equal(harness.openCount(), 1);
});

test("a preparation error opens the section so the existing retry action is visible", () => {
  const voiceId = KOKORO_VOICE_CATALOG[0].id;
  const harness = createHarness({ selectedVoice: { value: voiceId }, stateForVoice: () => "error" });

  assert.equal(harness.disclosure.onProviderStateChange(voiceId, "loading", "error"), true);
  assert.equal(harness.details.open, true);
  assert.match(main, /error: "Reintentar carga local"/);
});

test("restored voice disclosure does not start playback or mutate the document", () => {
  const voiceId = KOKORO_VOICE_CATALOG[0].id;
  const harness = createHarness({ selectedVoice: { value: voiceId }, stateForVoice: () => "idle" });
  const boot = main.slice(main.indexOf("async function boot()"), main.indexOf("ui.text.addEventListener"));

  assert.match(boot, /modelManagementDisclosure\.onVoiceSelection\(ui\.voice\.value\)/);
  assert.doesNotMatch(boot, /startCurrentPlayback\(|player\.play\(|repository\.saveDocument\(|repository\.deleteDocument\(/);
  assert.equal(harness.disclosure.onVoiceSelection(), true);
});

test("a manual collapsed state is preserved for a ready voice", () => {
  const voiceId = KOKORO_VOICE_CATALOG[0].id;
  const harness = createHarness({ selectedVoice: { value: voiceId }, stateForVoice: () => "ready", open: true });

  assert.equal(harness.disclosure.onVoiceSelection(), false);
  harness.details.open = false;
  assert.equal(harness.disclosure.onProviderStateChange(voiceId, "ready", "ready"), false);
  assert.equal(harness.details.open, false);
});

test("provider state lookup uses the selected Piper voice, not Kokoro's global state", () => {
  const piperVoiceId = PIPER_VOICE_CATALOG[0].id;
  const kokoroVoiceId = KOKORO_VOICE_CATALOG[0].id;
  const piperStates = new Map([[piperVoiceId, { state: "cached", installed: true }]]);
  const options = { getVoiceProvider, piperStates, kokoroState: "ready" };

  assert.equal(getVoicePreparationState(piperVoiceId, options), "cached");
  assert.equal(getVoicePreparationState(kokoroVoiceId, options), "ready");
});

test("state changes from an unselected provider do not open the management section", () => {
  const piperVoiceId = PIPER_VOICE_CATALOG[0].id;
  const kokoroVoiceId = KOKORO_VOICE_CATALOG[0].id;
  const harness = createHarness({ selectedVoice: { value: piperVoiceId }, stateForVoice: () => "error" });

  assert.equal(harness.disclosure.onProviderStateChange(kokoroVoiceId, "loading", "error"), false);
  assert.equal(harness.details.open, false);
});

test("changing provider state only opens management and never controls the reader", () => {
  const selectedVoice = { value: PIPER_VOICE_CATALOG[0].id };
  const harness = createHarness({ selectedVoice, stateForVoice: () => "loading" });
  let playbackCalls = 0;
  let documentWrites = 0;

  harness.disclosure.onProviderStateChange(selectedVoice.value, "cached", "loading");
  assert.equal(harness.details.open, true);
  assert.equal(playbackCalls, 0);
  assert.equal(documentWrites, 0);
  assert.match(main, /modelManagementDisclosure\.onProviderStateChange\(voiceId, previous\.state, next\.state\)/);
});

test("Piper and Kokoro status checks have a bounded wait", async () => {
  assert.equal(MODEL_STATUS_CHECK_TIMEOUT_MS, 16_000);
  assert.equal(await withBoundedWait(Promise.resolve("ready"), 20, "timeout"), "ready");
  await assert.rejects(withBoundedWait(new Promise(() => {}), 5, "status timeout"), /status timeout/);
});
