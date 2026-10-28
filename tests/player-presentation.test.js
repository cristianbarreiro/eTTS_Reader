import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { kokoroEngineLabel, playerHeaderState, readingDurationSummary, readingProgressCaption } from "../src/player-presentation.js";

const sidepanel = await readFile(fileURLToPath(new URL("../sidepanel.html", import.meta.url)), "utf8");
const styles = await readFile(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");

test("player heading exposes only meaningful playback states", () => {
  assert.equal(playerHeaderState("empty"), "");
  assert.equal(playerHeaderState("text-ready"), "Cola lista");
  assert.equal(playerHeaderState("stopped"), "");
  assert.equal(playerHeaderState("starting"), "Iniciando voz");
  assert.equal(playerHeaderState("generating"), "Preparando audio");
  assert.equal(playerHeaderState("audio-ready"), "Fragmento listo");
  assert.equal(playerHeaderState("playing"), "Reproduciendo");
  assert.equal(playerHeaderState("paused"), "Pausado");
  assert.equal(playerHeaderState("interrupted"), "Lectura interrumpida");
  assert.equal(playerHeaderState("error"), "Error");
});

test("document progress captions distinguish measured duration and pending fragments for local providers", () => {
  const base = { chunks: ["One", "Two"], activeKind: "chunk", totalProgress: 0.5 };
  assert.equal(readingProgressCaption({ ...base, totalDuration: null }), "Aprox. 50% por fragmentos");
  assert.equal(readingProgressCaption({ ...base, totalDuration: 20 }), "Tiempo total · 50%");
  assert.equal(readingProgressCaption({ ...base, activeProvider: "piper", totalDuration: 20 }), "Tiempo total · 50%");
  assert.equal(readingProgressCaption({ ...base, activeKind: "preview" }), "Muestra independiente");
  assert.equal(readingProgressCaption({ ...base, chunks: [] }), "Sin progreso");
});

test("Kokoro model inference stays indeterminate and reports elapsed time without a fabricated percentage", () => {
  const caption = readingProgressCaption({
    status: "generating",
    generationStage: "model-generate",
    generationProgress: null,
    generationCompletedParts: 0,
    generationTotalParts: 3,
    generationElapsedMs: 48_000
  });
  assert.equal(caption, "Inferencia local · parte 1/3 · 0:48 transcurridos");
  assert.doesNotMatch(caption, /0%/);
});

test("document preparation progress identifies the fragment being generated", () => {
  const caption = readingProgressCaption({
    status: "generating", generationStage: "request-started", generationPhase: "synthesis",
    generationProgress: null, generationFragmentIndex: 5, generationFragmentTotal: 12,
    generationElapsedMs: 3_000
  });
  assert.equal(caption, "Generando audio local · fragmento 5/12 · 0:03 transcurridos");
});

test("duration summary never presents zero as a measured duration before audio metadata exists", () => {
  const queued = { chunks: ["Hello."], durations: [null], totalDuration: null, knownDurationCount: 0, activeKind: "chunk" };
  assert.equal(readingDurationSummary(queued, "kokoro"), "Duración conocida — · total pendiente (0/1 fragmentos medidos)");
  assert.equal(readingDurationSummary({ ...queued, durations: [2.4], knownDurationCount: 1 }, "kokoro"), "Duración conocida 0:02 · total pendiente (1/1 fragmentos medidos)");
  assert.equal(readingDurationSummary(queued, "piper"), "Duración conocida — · total pendiente (0/1 fragmentos medidos)");
});

test("voice provider pill retains Kokoro identity while showing model availability", () => {
  assert.equal(kokoroEngineLabel("idle"), "Kokoro local");
  assert.equal(kokoroEngineLabel("loading"), "Cargando Kokoro");
  assert.equal(kokoroEngineLabel("ready"), "Kokoro listo");
  assert.equal(kokoroEngineLabel("error"), "Error de Kokoro");
});

test("the Spanish voice selector uses local Piper profiles and removes the Edge system-voice control", () => {
  assert.match(sidepanel, /Piper · español local/);
  assert.match(sidepanel, /piper:es_AR-daniela-high/);
  assert.match(sidepanel, /piper:es_ES-davefx-medium/);
  assert.doesNotMatch(sidepanel, /refresh-system-voices|voces de Edge\/Windows/);
});

test("player and voice sections have concise titles, and fragment times follow the seek bar", () => {
  assert.match(sidepanel, /<h2 id="playback-heading">Reproductor<\/h2>/);
  assert.match(sidepanel, /<h2 id="voice-heading">Voz<\/h2>/);
  assert.doesNotMatch(sidepanel, /<p class="section-kicker">LECTURA<\/p>/);

  const voiceSection = sidepanel.slice(sidepanel.indexOf('<section class="card voice-card"'), sidepanel.indexOf("</section>", sidepanel.indexOf('<section class="card voice-card"')));
  assert.doesNotMatch(voiceSection, /PROVEEDOR DE VOZ/);

  const seek = sidepanel.indexOf('id="seek"');
  const times = sidepanel.indexOf('class="time-row"');
  const controls = sidepanel.indexOf('class="player-controls"');
  assert.ok(seek >= 0 && seek < times && times < controls, "seek bar, time row, and controls must follow the requested order");
  assert.match(sidepanel, /id="elapsed"[\s\S]*?id="duration"/);
});

test("playback controls keep a centered single-row order and a larger primary action", () => {
  const controls = sidepanel.slice(sidepanel.indexOf('class="player-controls"'), sidepanel.indexOf("</div>", sidepanel.indexOf('class="player-controls"')));
  const order = ["id=\"previous\"", "id=\"play\"", "id=\"pause\"", "id=\"stop\"", "id=\"next\""];
  let previousIndex = -1;
  for (const item of order) {
    const index = controls.indexOf(item);
    assert.ok(index > previousIndex, `${item} should preserve the player control order`);
    previousIndex = index;
  }
  assert.match(styles, /\.player-controls\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*center/s);
  assert.match(styles, /\.player-controls \.play-button\s*\{[^}]*width:\s*46px[^}]*height:\s*46px/s);
  assert.match(styles, /\.player-controls \.control-button\s*\{[^}]*height:\s*40px/s);
});

test("play and pause are icon-only controls with accessible action names", () => {
  const play = sidepanel.match(/<button id="play"[^>]*>([\s\S]*?)<\/button>/);
  const pause = sidepanel.match(/<button id="pause"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(play);
  assert.ok(pause);
  assert.match(play[0], /aria-label="Reproducir lectura"/);
  assert.match(pause[0], /aria-label="Pausar lectura"/);
  assert.doesNotMatch(play[1], /Reproducir|<span/);
  assert.doesNotMatch(pause[1], /Pausar|<span/);
});
