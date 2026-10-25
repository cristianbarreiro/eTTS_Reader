import test from "node:test";
import assert from "node:assert/strict";
import { isSelectedPiperVoiceMessage, shouldAcceptPiperOperationMessage } from "../src/piper-ui-state.js";

const daniela = "piper:es_AR-daniela-high";
const daveFx = "piper:es_ES-davefx-medium";

test("late model messages from a retired Piper operation cannot replace a newer operation state", () => {
  const current = { state: "loading", operationId: "panel-2" };
  const retired = new Set(["panel-1"]);

  assert.equal(shouldAcceptPiperOperationMessage({ type: "reader:model", state: "error", voiceId: daniela, operationId: "panel-1" }, current, retired), false);
  assert.equal(shouldAcceptPiperOperationMessage({ type: "reader:model-progress", voiceId: daniela, operationId: "panel-2" }, current, retired), true);
});

test("only the selected Piper voice may control shared progress and status presentation", () => {
  assert.equal(isSelectedPiperVoiceMessage(daveFx, daniela), false);
  assert.equal(isSelectedPiperVoiceMessage(daniela, daniela), true);
  assert.equal(isSelectedPiperVoiceMessage(daniela, daveFx), false);
});
