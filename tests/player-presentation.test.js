import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { kokoroEngineLabel, playerHeaderState, readingProgressCaption } from "../src/player-presentation.js";

const sidepanel = await readFile(fileURLToPath(new URL("../sidepanel.html", import.meta.url)), "utf8");
const styles = await readFile(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");

test("player heading exposes only meaningful playback states", () => {
  assert.equal(playerHeaderState("empty"), "");
  assert.equal(playerHeaderState("text-ready"), "");
  assert.equal(playerHeaderState("stopped"), "");
  assert.equal(playerHeaderState("generating"), "Preparando audio");
  assert.equal(playerHeaderState("playing"), "Reproduciendo");
  assert.equal(playerHeaderState("paused"), "Pausado");
  assert.equal(playerHeaderState("interrupted"), "Lectura interrumpida");
  assert.equal(playerHeaderState("error"), "Error");
});

test("document progress captions distinguish temporal, chunk-based, and system speech progress", () => {
  const base = { chunks: ["One", "Two"], activeKind: "chunk", totalProgress: 0.5 };
  assert.equal(readingProgressCaption({ ...base, totalDuration: null }), "Aprox. 50% por fragmentos");
  assert.equal(readingProgressCaption({ ...base, totalDuration: 20 }), "Tiempo total · 50%");
  assert.equal(readingProgressCaption({ ...base, activeProvider: "speechSynthesis" }), "Aprox. 50% por texto");
  assert.equal(readingProgressCaption({ ...base, activeKind: "preview" }), "Muestra independiente");
  assert.equal(readingProgressCaption({ ...base, chunks: [] }), "Sin progreso");
});

test("voice provider pill retains Kokoro identity while showing model availability", () => {
  assert.equal(kokoroEngineLabel("idle"), "Kokoro local");
  assert.equal(kokoroEngineLabel("loading"), "Cargando Kokoro");
  assert.equal(kokoroEngineLabel("ready"), "Kokoro listo");
  assert.equal(kokoroEngineLabel("error"), "Error de Kokoro");
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
