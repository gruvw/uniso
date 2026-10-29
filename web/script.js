'use strict';

/* ------------------------------------------------------------------ *
 * Keyboard → MIDI
 * Maps physical keys (KeyboardEvent.code) to MIDI notes and sends them
 * through Web MIDI to a chosen output port.
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'keyboard-midi-mapper.v1';
const FILE_TAG = 'keyboard-midi-mapper';
const FILE_VERSION = 1;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DEFAULT_VELOCITY = 100;
const PREVIEW_MS = 400;
const LOG_LIMIT = 60;

/* Whole-tone piano: even MIDI notes are bottom-row ("white") keys
   C D E F# G# A#, odd notes are top-row ("black") keys C# D# F G A B,
   each black key sitting a semitone up and to the right of its white key. */
const PIANO_FIRST = 24; // C1 (C4 = MIDI 60)
const PIANO_LAST = 95;  // B6
const KEY_SYMBOLS = {
  Shift: '⇧', Control: 'Ctrl', Alt: 'Alt', AltGraph: 'AltGr', Meta: '⌘',
  Enter: '⏎', Backspace: '⌫', Tab: '⇥', Space: '␣', Escape: 'Esc', CapsLock: '⇪',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Delete: 'Del', Insert: 'Ins', PageUp: 'PgUp', PageDown: 'PgDn', ContextMenu: 'Menu',
};

/* Scales: semitone steps from the root. */
const SCALES = [
  { group: 'Major & modes', items: [
    { id: 'major', name: 'Major (Ionian)', steps: [0, 2, 4, 5, 7, 9, 11] },
    { id: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
    { id: 'phrygian', name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
    { id: 'lydian', name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
    { id: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
    { id: 'minor', name: 'Natural minor (Aeolian)', steps: [0, 2, 3, 5, 7, 8, 10] },
    { id: 'locrian', name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  ] },
  { group: 'Minor variants', items: [
    { id: 'harmonic-minor', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
    { id: 'melodic-minor', name: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  ] },
  { group: 'Pentatonic & blues', items: [
    { id: 'major-pentatonic', name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    { id: 'minor-pentatonic', name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    { id: 'blues', name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  ] },
  { group: 'Symmetric', items: [
    { id: 'whole-tone', name: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
    { id: 'dim-wh', name: 'Diminished (whole–half)', steps: [0, 2, 3, 5, 6, 8, 9, 11] },
    { id: 'dim-hw', name: 'Diminished (half–whole)', steps: [0, 1, 3, 4, 6, 7, 9, 10] },
    { id: 'chromatic', name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ] },
];

/* Chords: semitone steps from the root and the interval label of each tone. */
const chord = (id, name, symbol, steps, degrees) => ({ id, name, symbol, steps, degrees: degrees.split(' ') });
const CHORDS = [
  { group: 'Triads', items: [
    chord('maj', 'Major', '', [0, 4, 7], 'R 3 5'),
    chord('min', 'Minor', 'm', [0, 3, 7], 'R b3 5'),
    chord('dim', 'Diminished', 'dim', [0, 3, 6], 'R b3 b5'),
    chord('aug', 'Augmented', 'aug', [0, 4, 8], 'R 3 #5'),
    chord('sus2', 'Suspended 2nd', 'sus2', [0, 2, 7], 'R 2 5'),
    chord('sus4', 'Suspended 4th', 'sus4', [0, 5, 7], 'R 4 5'),
  ] },
  { group: 'Sixths & sevenths', items: [
    chord('6', 'Major 6th', '6', [0, 4, 7, 9], 'R 3 5 6'),
    chord('m6', 'Minor 6th', 'm6', [0, 3, 7, 9], 'R b3 5 6'),
    chord('7', 'Dominant 7th', '7', [0, 4, 7, 10], 'R 3 5 b7'),
    chord('maj7', 'Major 7th', 'maj7', [0, 4, 7, 11], 'R 3 5 7'),
    chord('m7', 'Minor 7th', 'm7', [0, 3, 7, 10], 'R b3 5 b7'),
    chord('mmaj7', 'Minor-major 7th', 'm(maj7)', [0, 3, 7, 11], 'R b3 5 7'),
    chord('m7b5', 'Half-diminished 7th', 'm7♭5', [0, 3, 6, 10], 'R b3 b5 b7'),
    chord('dim7', 'Diminished 7th', 'dim7', [0, 3, 6, 9], 'R b3 b5 bb7'),
    chord('aug7', 'Augmented 7th', 'aug7', [0, 4, 8, 10], 'R 3 #5 b7'),
    chord('7sus4', 'Dominant 7th sus4', '7sus4', [0, 5, 7, 10], 'R 4 5 b7'),
  ] },
  { group: 'Ninths', items: [
    chord('add9', 'Add 9', 'add9', [0, 4, 7, 14], 'R 3 5 9'),
    chord('9', 'Dominant 9th', '9', [0, 4, 7, 10, 14], 'R 3 5 b7 9'),
    chord('maj9', 'Major 9th', 'maj9', [0, 4, 7, 11, 14], 'R 3 5 7 9'),
    chord('m9', 'Minor 9th', 'm9', [0, 3, 7, 10, 14], 'R b3 5 b7 9'),
  ] },
  { group: 'More', items: [
    chord('p5', 'Power chord', '5', [0, 7], 'R 5'),
    chord('7no5', 'Dominant 7th (no 5th)', '7(no5)', [0, 4, 10], 'R 3 b7'),
    chord('maj7no5', 'Major 7th (no 5th)', 'maj7(no5)', [0, 4, 11], 'R 3 7'),
    chord('m7no5', 'Minor 7th (no 5th)', 'm7(no5)', [0, 3, 10], 'R b3 b7'),
    chord('madd9', 'Minor add 9', 'm(add9)', [0, 3, 7, 14], 'R b3 5 9'),
    chord('69', 'Six-nine', '6/9', [0, 4, 7, 9, 14], 'R 3 5 6 9'),
    chord('7b9', 'Dominant 7th flat 9', '7♭9', [0, 4, 7, 10, 13], 'R 3 5 b7 b9'),
    chord('7s9', 'Dominant 7th sharp 9', '7♯9', [0, 4, 7, 10, 15], 'R 3 5 b7 #9'),
    chord('m11', 'Minor 11th', 'm11', [0, 3, 7, 10, 14, 17], 'R b3 5 b7 9 11'),
    chord('13', 'Dominant 13th', '13', [0, 4, 7, 10, 14, 21], 'R 3 5 b7 9 13'),
  ] },
];
const CHORD_OCTAVE_C = 60; // chords are rooted in octave 4 (C4–B4)

/* Other common ways to write each chord symbol. */
const CHORD_ALIASES = {
  maj: ['M', 'maj'], min: ['min', '−'], dim: ['°', 'm♭5'], aug: ['+', '(♯5)'],
  6: ['M6', 'maj6'], m6: ['min6', '−6'], 7: ['dom7'], maj7: ['M7', 'Δ7'], m7: ['min7', '−7'],
  mmaj7: ['mM7', 'mΔ7'], m7b5: ['ø7', 'min7♭5'], dim7: ['°7'], aug7: ['+7', '7♯5'],
  add9: ['add2'], maj9: ['M9', 'Δ9'], m9: ['min9', '−9'], p5: ['(no3)'], '69': ['6add9'],
};
const DEGREE_NAMES = {
  R: 'Root', b2: 'Minor 2nd', 2: 'Major 2nd', b3: 'Minor 3rd', 3: 'Major 3rd', 4: 'Perfect 4th',
  b5: 'Diminished 5th', 5: 'Perfect 5th', '#5': 'Augmented 5th', 6: 'Major 6th',
  bb7: 'Diminished 7th', b7: 'Minor 7th', 7: 'Major 7th', b9: 'Minor 9th', 9: 'Major 9th',
  '#9': 'Augmented 9th', 11: 'Perfect 11th', 13: 'Major 13th',
};
const INTERVAL_NAMES = [
  'unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th',
  'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th',
];
const COMPOUND_INTERVALS = {
  12: 'octave', 13: 'minor 9th', 14: 'major 9th', 15: 'minor 10th', 16: 'major 10th',
  17: 'perfect 11th', 18: 'augmented 11th', 19: 'perfect 12th', 20: 'minor 13th',
  21: 'major 13th', 22: 'minor 14th', 23: 'major 14th', 24: 'two octaves',
};
const HISTORY_MAX = 8;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const TRIAD_IDS = ['maj', 'min', 'dim', 'aug'];
const HISTORY_SETTLE_MS = 200; // a chord must be held this long to enter the history
const RELEASE_GRACE_MS = 160; // fingers lifted within this window count as one release
const INVERSION_NAMES = ['Root position', '1st inversion', '2nd inversion', '3rd inversion', '4th inversion', '5th inversion'];
const CHORD_PREVIEW_MS = 1200;

const pcSetKey = (steps) => [...new Set(steps.map((x) => ((x % 12) + 12) % 12))].sort((a, b) => a - b).join(',');
const CHORD_TEMPLATES = CHORDS.flatMap((g) => g.items).map((t) => ({
  ...t,
  key: pcSetKey(t.steps),
  degreeByPc: new Map(t.steps.map((step, i) => [step % 12, t.degrees[i]])),
}));

const findIn = (groups, id) => {
  for (const g of groups) for (const item of g.items) if (item.id === id) return item;
  return null;
};

const state = {
  midi: null,                 // MIDIAccess
  output: null,               // current MIDIOutput
  preferredOutputName: '',    // remembered between sessions
  defaultChannel: 1,          // 1..16
  mappings: new Map(),        // code -> { code, label, note, channel|null, velocity }
  capturing: false,           // waiting for a key press to map
  editing: null,              // { code, label } while the note dialog is open
  held: new Map(),            // code -> { note, channel } for keys currently down
  sounding: new Map(),        // "channel:note" -> number of sources holding it
  preview: null,              // { notes, channel, timer }
  view: null,                 // saved scale / chord / display options
  detectQueued: false,
  npLast: null,               // last chord shown, kept after release
  liveShown: null,            // live detection currently on screen
  lastCount: 0,               // distinct notes sounding at the previous update
  releaseFrom: null,          // chord held before the current release began
  releaseTimer: null,
  displaySymbol: null,        // detected chord currently on screen (outlined in the history)
  history: [],                // recent chords [{ root, id, inv, symbol, fullName }]
  historyTimer: null,
  pointerNote: null,          // { note, channel } while a piano key is clicked
  lastNote: null,
};

const pianoKeys = new Map();  // note -> Uniso piano key element
const stdKeys = new Map();    // note -> standard piano key element
const STD_WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
const pianoCenters = new Map(); // note -> CSS expression for the key's horizontal centre

const $ = (id) => document.getElementById(id);
const els = {
  status: $('midiStatus'),
  outputSelect: $('outputSelect'),
  channelSelect: $('channelSelect'),
  panicBtn: $('panicBtn'),
  addBtn: $('addBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importInput: $('importInput'),
  clearBtn: $('clearBtn'),
  captureBanner: $('captureBanner'),
  mapTable: $('mapTable'),
  mapBody: $('mapBody'),
  mapCount: $('mapCount'),
  emptyMsg: $('emptyMsg'),
  log: $('log'),
  clearLogBtn: $('clearLogBtn'),
  dialog: $('noteDialog'),
  dlgTitle: $('dlgTitle'),
  dlgKey: $('dlgKey'),
  dlgCode: $('dlgCode'),
  dlgNote: $('dlgNote'),
  dlgChannel: $('dlgChannel'),
  dlgVelocity: $('dlgVelocity'),
  dlgVelOut: $('dlgVelOut'),
  dlgPreview: $('dlgPreview'),
  piano: $('piano'),
  stdPiano: $('stdPiano'),
  stdToggle: $('stdToggle'),
  pianoScroll: $('pianoScroll'),
  scaleRoot: $('scaleRoot'),
  scaleType: $('scaleType'),
  scaleNotes: $('scaleNotes'),
  scaleTriads: $('scaleTriads'),
  chordRoot: $('chordRoot'),
  chordType: $('chordType'),
  chordInv: $('chordInv'),
  chordPlay: $('chordPlay'),
  chordLane: $('chordLane'),
  laneRuler: $('laneRuler'),
  laneBadges: $('laneBadges'),
  bindsToggle: $('bindsToggle'),
  scaleClear: $('scaleClear'),
  chordAction: $('chordAction'),
  npMode: $('npMode'),
  npState: $('npState'),
  npBody: $('npBody'),
  npSymbol: $('npSymbol'),
  npName: $('npName'),
  npMeta: $('npMeta'),
  npAlt: $('npAlt'),
  npTonesLabel: $('npTonesLabel'),
  npTones: $('npTones'),
  npHistory: $('npHistory'),
  npHistoryClear: $('npHistoryClear'),
};

/* ------------------------------ helpers ----------------------------- */

function noteName(n) {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

function toInt(value, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

/** Stable identifier for a physical key. */
function keyId(e) {
  if (e.code) return e.code;
  return e.key ? `key:${e.key}` : '';
}

/** Human-readable label for a key press (layout-aware where possible). */
function keyLabel(e) {
  const { key, code = '' } = e;
  if (code.startsWith('Numpad')) {
    return 'Num ' + (key && key.length === 1 ? key : code.slice(6));
  }
  if (key === ' ') return 'Space';
  if (!key || key === 'Dead' || key === 'Unidentified' || key === 'Process') {
    return code.replace(/^Key/, '').replace(/^Digit/, '') || '?';
  }
  if (key.length === 1) return key.toUpperCase();
  const side = /(Left|Right)$/.exec(code);
  if (side && ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(key)) {
    return `${key} ${side[1]}`;
  }
  return key;
}

function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function effectiveChannel(mapping) {
  return mapping.channel ?? state.defaultChannel;
}

/* ------------------------------ UI setup ---------------------------- */

function fillNoteSelect(select) {
  select.replaceChildren();
  for (let octave = -1; octave <= 9; octave++) {
    const group = el('optgroup', { label: `Octave ${octave}` });
    for (let i = 0; i < 12; i++) {
      const n = (octave + 1) * 12 + i;
      if (n > 127) break;
      group.append(new Option(`${noteName(n)}  ·  ${n}`, String(n)));
    }
    select.append(group);
  }
}

function fillChannelSelect(select, withDefault) {
  select.replaceChildren();
  if (withDefault) select.append(new Option('Default', ''));
  for (let ch = 1; ch <= 16; ch++) select.append(new Option(`Channel ${ch}`, String(ch)));
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function addLog(text, isError = false) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const li = el('li', { textContent: `${time}  ${text}` });
  if (isError) li.className = 'err';
  els.log.prepend(li);
  while (els.log.children.length > LOG_LIMIT) els.log.lastElementChild.remove();
}

/* ------------------------------ Web MIDI ---------------------------- */

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setStatus('Web MIDI is not available in this browser — use Chrome, Edge or Opera.', 'error');
    els.outputSelect.replaceChildren(new Option('Web MIDI unavailable', ''));
    return;
  }
  try {
    state.midi = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    setStatus(`MIDI access was refused (${err && err.name ? err.name : err}). Allow MIDI for this page and reload.`, 'error');
    els.outputSelect.replaceChildren(new Option('No MIDI access', ''));
    return;
  }
  state.midi.addEventListener('statechange', refreshOutputs);
  refreshOutputs();
}

function refreshOutputs() {
  if (!state.midi) return;
  const outputs = [...state.midi.outputs.values()].filter((o) => o.state !== 'disconnected');
  const select = els.outputSelect;
  select.replaceChildren();

  if (outputs.length === 0) {
    select.append(new Option('No MIDI outputs found', ''));
    select.disabled = true;
    setOutput(null);
    setStatus('No MIDI output ports — create a virtual MIDI port (IAC Driver, loopMIDI…).', 'warn');
    return;
  }

  select.disabled = false;
  for (const o of outputs) {
    const label = o.manufacturer && !o.name.includes(o.manufacturer)
      ? `${o.name} (${o.manufacturer})`
      : o.name;
    select.append(new Option(label, o.id));
  }

  const chosen =
    outputs.find((o) => state.output && o.id === state.output.id) ||
    outputs.find((o) => o.name === state.preferredOutputName) ||
    outputs[0];

  select.value = chosen.id;
  if (!state.output || state.output.id !== chosen.id) setOutput(chosen);
  setStatus(`Sending to “${chosen.name}” · ${outputs.length} output${outputs.length > 1 ? 's' : ''} available`, 'ok');
}

function setOutput(output) {
  // Release anything sounding on the previous port before switching.
  releaseAll();
  stopPreview();
  releasePointerNote();
  state.output = output;
  if (output) {
    state.preferredOutputName = output.name;
    if (typeof output.open === 'function') output.open().catch(() => {});
    addLog(`Output → ${output.name}`);
    save();
  }
}

function send(bytes) {
  if (!state.output) return false;
  try {
    state.output.send(bytes);
    return true;
  } catch (err) {
    addLog(`Send failed: ${err && err.message ? err.message : err}`, true);
    return false;
  }
}

function sendNoteOn(note, channel, velocity) {
  const ok = send([0x90 | (channel - 1), note, velocity]);
  addLog(ok
    ? `Note on   ${noteName(note).padEnd(4)} (${note}) · ch ${channel} · vel ${velocity}`
    : `Note on   ${noteName(note)} — no output selected`, !ok);
  return ok;
}

function sendNoteOff(note, channel) {
  const ok = send([0x80 | (channel - 1), note, 0]);
  if (ok) addLog(`Note off  ${noteName(note).padEnd(4)} (${note}) · ch ${channel}`);
  return ok;
}

/* Reference counting so two keys (or a key + preview) on the same note
   don't cut each other off when one of them is released. */
function startVoice(note, channel, velocity) {
  const k = `${channel}:${note}`;
  state.sounding.set(k, (state.sounding.get(k) || 0) + 1);
  sendNoteOn(note, channel, velocity);
  updatePianoNote(note);
  scheduleDetect();
}

function stopVoice(note, channel) {
  const k = `${channel}:${note}`;
  const remaining = (state.sounding.get(k) || 0) - 1;
  if (remaining > 0) {
    state.sounding.set(k, remaining);
  } else {
    state.sounding.delete(k);
    sendNoteOff(note, channel);
  }
  updatePianoNote(note);
  scheduleDetect();
}

function panic() {
  releaseAll();
  stopPreview();
  releasePointerNote();
  state.sounding.clear();
  for (const key of [...pianoKeys.values(), ...stdKeys.values()]) key.classList.remove('active');
  scheduleDetect();
  for (let ch = 0; ch < 16; ch++) {
    send([0xb0 | ch, 123, 0]); // All Notes Off
    send([0xb0 | ch, 120, 0]); // All Sound Off
  }
  addLog(state.output ? 'All notes off (ch 1–16)' : 'All notes off — no output selected', !state.output);
}

/* ------------------------------ playing ----------------------------- */

function pressKey(code) {
  const mapping = state.mappings.get(code);
  if (!mapping || state.held.has(code)) return;
  const channel = effectiveChannel(mapping);
  state.held.set(code, { note: mapping.note, channel });
  startVoice(mapping.note, channel, mapping.velocity);
  markActive(code, true);
}

function releaseKey(code) {
  const held = state.held.get(code);
  if (!held) return;
  state.held.delete(code);
  stopVoice(held.note, held.channel);
  markActive(code, false);
}

function releaseAll() {
  for (const code of [...state.held.keys()]) releaseKey(code);
}

/** Play one note or several (a chord) for a short time. */
function preview(notes, channel, velocity, ms = PREVIEW_MS) {
  stopPreview();
  const list = [].concat(notes);
  for (const n of list) startVoice(n, channel, velocity);
  state.preview = { notes: list, channel, timer: setTimeout(stopPreview, ms) };
}

function stopPreview() {
  const p = state.preview;
  if (!p) return;
  clearTimeout(p.timer);
  state.preview = null;
  for (const n of p.notes) stopVoice(n, p.channel);
}

function markActive(code, on) {
  const row = els.mapBody.querySelector(`tr[data-code="${CSS.escape(code)}"]`);
  if (row) row.classList.toggle('active', on);
}

/* ------------------------------- piano ------------------------------ */

function buildPiano() {
  const whites = [];
  const blacks = [];
  for (let n = PIANO_FIRST; n <= PIANO_LAST; n++) {
    const pc = n % 12;
    const isWhite = n % 2 === 0;
    const key = el('div', { className: `pk ${isWhite ? 'pk-white' : 'pk-black'}` },
      el('span', { className: 'pk-binds' }),
      el('span', { className: 'pk-name', textContent: pc === 0 ? noteName(n) : NOTE_NAMES[pc] }),
    );
    if (pc === 0 || pc === 5) key.classList.add('grey'); // C and F
    if (isWhite) {
      pianoCenters.set(n, `calc(${(n - PIANO_FIRST) / 2 + 0.5} * var(--wk))`);
    } else {
      // Centered on the boundary to the right of the white key one semitone below.
      const whiteIndex = (n - 1 - PIANO_FIRST) / 2;
      key.style.left = `calc(${whiteIndex + 1} * var(--wk) - var(--bk) / 2)`;
      pianoCenters.set(n, `calc(${whiteIndex + 1} * var(--wk))`);
    }
    key.dataset.note = String(n);
    pianoKeys.set(n, key);
    (isWhite ? whites : blacks).push(key);
  }
  document.documentElement.style.setProperty('--white-count', String(whites.length));
  els.piano.replaceChildren(...whites, ...blacks);

  // Octave ruler: a tick and label at each C. The chord's interval badges use the same
  // strip, so selecting a chord never changes the height of the piano panel.
  const marks = [];
  for (let n = PIANO_FIRST; n <= PIANO_LAST; n += 12) {
    const mark = el('span', { className: 'lane-oct' }, el('span', { textContent: `Octave ${Math.floor(n / 12) - 1}` }));
    mark.style.left = pianoCenters.get(n);
    marks.push(mark);
  }
  els.laneRuler.replaceChildren(...marks);
}

/** Compact label for a key chip, e.g. "Shift Left" → "⇧L". */
function shortKeyLabel(label) {
  const sided = /^(.+?) (Left|Right)$/.exec(label);
  const base = sided ? sided[1] : label;
  const side = sided ? sided[2][0] : '';
  const short = KEY_SYMBOLS[base] ?? (base.startsWith('Num ') ? 'N' + base.slice(4) : base);
  return short + side;
}

/* KeyboardEvent.code names physical keys by their position on a US QWERTY
   board, whatever layout the OS uses, so these labels are the physical keys. */
const CODE_LABELS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  IntlBackslash: '<', IntlRo: 'Ro', IntlYen: '¥',
};
const NUMPAD_LABELS = {
  Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Decimal: '.',
  Enter: '⏎', Equal: '=', Comma: ',',
};

/** Compact label of the physical key a mapping uses, e.g. KeyZ → "Z". */
function physicalKeyLabel(mapping) {
  const { code } = mapping;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if (code in CODE_LABELS) return CODE_LABELS[code];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'N' + (NUMPAD_LABELS[m[1]] ?? m[1]);
  if ((m = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.exec(code))) {
    return KEY_SYMBOLS[m[1] === 'OS' ? 'Meta' : m[1]] + m[2][0];
  }
  if (code in KEY_SYMBOLS) return KEY_SYMBOLS[code];
  if (code.startsWith('key:')) return shortKeyLabel(mapping.label); // browser gave no code
  return code; // F1–F12 and other named keys
}

function renderPianoBindings() {
  const byNote = new Map();
  for (const m of state.mappings.values()) {
    if (!pianoKeys.has(m.note)) continue;
    if (!byNote.has(m.note)) byNote.set(m.note, []);
    byNote.get(m.note).push(m);
  }

  for (const [note, key] of pianoKeys) {
    const list = byNote.get(note) || [];
    const chips = list.slice(0, 2).map((m) => el('span', { className: 'pk-bind', textContent: physicalKeyLabel(m) }));
    if (list.length > 2) chips.push(el('span', { className: 'pk-more', textContent: `+${list.length - 2}` }));
    key.querySelector('.pk-binds').replaceChildren(...chips);
    key.classList.toggle('mapped', list.length > 0);
    key.title = `${noteName(note)} · MIDI ${note} · ` +
      (list.length ? list.map((m) => `physical key ${physicalKeyLabel(m)} (${m.code}, types “${m.label}”)`).join(', ') : 'not mapped');
  }
}

function noteSounding(note) {
  for (const k of state.sounding.keys()) {
    if (Number(k.slice(k.indexOf(':') + 1)) === note) return true;
  }
  return false;
}

function updatePianoNote(note) {
  const on = noteSounding(note);
  pianoKeys.get(note)?.classList.toggle('active', on);
  stdKeys.get(note)?.classList.toggle('active', on);
}

/**
 * Regular piano layout (7 white + 5 black keys per octave) over the same range.
 * Its white keys are 6/7 as wide as the Uniso ones, so one octave spans exactly
 * the same width on both pianos and every C lines up vertically.
 */
function buildStdPiano() {
  const whites = [];
  const blacks = [];
  let whiteCount = 0;
  for (let n = PIANO_FIRST; n <= PIANO_LAST; n++) {
    const pc = n % 12;
    const isWhite = STD_WHITE_PCS.has(pc);
    const key = el('div', { className: `pk ${isWhite ? 'pk-white' : 'pk-black'}` },
      el('span', { className: 'pk-name', textContent: pc === 0 ? noteName(n) : NOTE_NAMES[pc] }));
    if (pc === 0 || pc === 5) key.classList.add('grey'); // C and F
    if (isWhite) {
      whiteCount++;
      whites.push(key);
    } else {
      key.style.left = `calc(${whiteCount} * var(--swk) - var(--sbk) / 2)`;
      blacks.push(key);
    }
    key.dataset.note = String(n);
    stdKeys.set(n, key);
  }
  els.stdPiano.replaceChildren(...whites, ...blacks);
}

function stdShown() {
  return els.stdToggle.getAttribute('aria-pressed') === 'true';
}

function setStdShown(on) {
  els.stdToggle.setAttribute('aria-pressed', String(on));
  els.stdPiano.hidden = !on;
}

/** Scroll the piano so the mapped range (or middle C) is centered. */
function scrollPianoToMappings() {
  const notes = [...state.mappings.values()].map((m) => m.note).filter((n) => pianoKeys.has(n));
  const lo = pianoKeys.get(notes.length ? Math.min(...notes) : 60);
  const hi = pianoKeys.get(notes.length ? Math.max(...notes) : 60);
  const center = (lo.offsetLeft + hi.offsetLeft + hi.offsetWidth) / 2;
  els.pianoScroll.scrollLeft = Math.max(0, center - els.pianoScroll.clientWidth / 2);
}

function onPianoPointerDown(e) {
  const key = e.target.closest('.pk');
  if (!key || e.button !== 0) return;
  e.preventDefault();
  releasePointerNote();
  const note = Number(key.dataset.note);
  const mapping = [...state.mappings.values()].find((m) => m.note === note);
  const channel = mapping ? effectiveChannel(mapping) : state.defaultChannel;
  const velocity = mapping ? mapping.velocity : DEFAULT_VELOCITY;
  state.pointerNote = { note, channel };
  startVoice(note, channel, velocity);
  try {
    key.setPointerCapture(e.pointerId);
  } catch {
    /* not critical */
  }
}

function releasePointerNote() {
  const p = state.pointerNote;
  if (!p) return;
  state.pointerNote = null;
  stopVoice(p.note, p.channel);
}

/* -------------------------- scales & chords ------------------------- */

function fillTheorySelects() {
  for (const select of [els.scaleRoot, els.chordRoot]) {
    select.replaceChildren(...NOTE_NAMES.map((name, pc) => new Option(name, String(pc))));
  }
  const fill = (select, groups) => {
    select.replaceChildren(new Option('None', ''));
    for (const g of groups) {
      const group = el('optgroup', { label: g.group });
      for (const item of g.items) group.append(new Option(item.name, item.id));
      select.append(group);
    }
  };
  fill(els.scaleType, SCALES);
  fill(els.chordType, CHORDS);
  els.chordType.options[0].textContent = 'None (auto-detect)';
  fillInversions('0');
}

/** Voicing choices for the selected chord: root position and each inversion. */
function fillInversions(value) {
  const c = findIn(CHORDS, els.chordType.value);
  if (!c) {
    els.chordInv.replaceChildren(new Option(INVERSION_NAMES[0], '0'));
    els.chordInv.disabled = true;
    return;
  }
  els.chordInv.disabled = false;
  els.chordInv.replaceChildren(...c.steps.map((_, i) => new Option(
    i === 0 ? INVERSION_NAMES[0] : `${INVERSION_NAMES[i]} · ${fmtDegree(c.degrees[i])} in bass`, String(i))));
  els.chordInv.value = Number(value) < c.steps.length ? String(Number(value) || 0) : '0';
}

/** The selected chord voiced in octave 4: inversion k moves the lowest k tones up an octave,
    then the whole chord is shifted so its bass note sits in C4–B4. */
function currentChordNotes() {
  const c = findIn(CHORDS, els.chordType.value);
  if (!c) return null;
  const root = CHORD_OCTAVE_C + Number(els.chordRoot.value);
  const inversion = Math.min(Number(els.chordInv.value) || 0, c.steps.length - 1);
  let voiced = c.steps
    .map((step, i) => ({ note: root + step + (i < inversion ? 12 : 0), degree: c.degrees[i] }))
    .sort((a, b) => a.note - b.note);
  const shift = voiced[0].note >= CHORD_OCTAVE_C + 12 ? -12 : 0;
  voiced = voiced.map((v) => ({ note: v.note + shift, degree: v.degree }));
  return { chord: c, root: root + shift, inversion, voiced, notes: voiced.map((v) => v.note) };
}

function renderTheory() {
  const scale = findIn(SCALES, els.scaleType.value);
  const scaleRoot = Number(els.scaleRoot.value);
  const scalePcs = scale ? new Set(scale.steps.map((s) => (scaleRoot + s) % 12)) : null;

  const current = currentChordNotes();
  const chordTones = new Map();
  if (current) for (const v of current.voiced) chordTones.set(v.note, v.degree);

  els.piano.classList.toggle('scale-on', !!scale);
  els.stdPiano.classList.toggle('scale-on', !!scale);
  for (const [note, key] of [...pianoKeys, ...stdKeys]) {
    const pc = note % 12;
    key.classList.toggle('in-scale', !!scalePcs && scalePcs.has(pc));
    key.classList.toggle('scale-root', !!scale && pc === scaleRoot);
    const degree = chordTones.get(note);
    key.classList.toggle('in-chord', degree !== undefined);
    key.classList.toggle('chord-root', degree === 'R');
  }

  // Interval labels live in a strip above the piano, centred on each chord key.
  const badges = [];
  for (const [note, degree] of chordTones) {
    if (!pianoCenters.has(note)) continue;
    const badge = el('span', {
      className: `lane-degree${degree === 'R' ? ' root' : ''}`,
      textContent: fmtDegree(degree),
      title: `${noteName(note)} · ${DEGREE_NAMES[degree] || degree}`,
    });
    badge.style.left = pianoCenters.get(note);
    badges.push(badge);
  }
  els.laneBadges.replaceChildren(...badges);
  els.chordLane.classList.toggle('has-chord', !!current);

  els.scaleNotes.replaceChildren(...(scale
    ? scaleNoteItems(scale, scaleRoot)
    : [el('li', { className: 'scale-none', textContent: 'No scale' })]));
  els.scaleClear.disabled = !scale;
  renderScaleTriads(scale, scaleRoot);
  els.chordPlay.disabled = !current;

  updateNowPlaying(); // the selection and the scale both feed the chord panel
  renderHistory();    // marks the history entry matching the selection
}

/**
 * Triads that belong to a scale.
 * 7-note scales: one triad per degree, stacked in thirds, with its Roman numeral.
 * Other scales: every major / minor / diminished / augmented triad whose notes
 * are all in the scale.
 */
function scaleTriads(scale, scaleRoot) {
  const triads = TRIAD_IDS.map((id) => CHORD_TEMPLATES.find((t) => t.id === id));
  const n = scale.steps.length;
  if (n >= 12) return null; // chromatic: every triad fits
  if (n === 7) {
    return scale.steps.map((step, i) => {
      const third = (scale.steps[(i + 2) % 7] - step + 12) % 12;
      const fifth = (scale.steps[(i + 4) % 7] - step + 12) % 12;
      const t = triads.find((x) => x.steps[1] === third && x.steps[2] === fifth);
      if (!t) return null;
      const minor = t.id === 'min' || t.id === 'dim';
      const numeral = (minor ? ROMAN[i].toLowerCase() : ROMAN[i]) + (t.id === 'dim' ? '°' : t.id === 'aug' ? '+' : '');
      return { root: (scaleRoot + step) % 12, t, numeral };
    }).filter(Boolean);
  }
  const inScale = new Set(scale.steps);
  const out = [];
  for (const step of scale.steps) {
    for (const t of triads) {
      if (t.steps.every((x) => inScale.has((step + x) % 12))) out.push({ root: (scaleRoot + step) % 12, t, numeral: '' });
    }
  }
  return out;
}

function renderScaleTriads(scale, scaleRoot) {
  if (!scale) {
    els.scaleTriads.replaceChildren(el('span', { className: 'scale-none', textContent: 'No scale' }));
    return;
  }
  const list = scaleTriads(scale, scaleRoot);
  if (!list) {
    els.scaleTriads.replaceChildren(el('span', { className: 'scale-none', textContent: 'Every triad fits this scale' }));
    return;
  }
  if (!list.length) {
    els.scaleTriads.replaceChildren(el('span', { className: 'scale-none', textContent: 'No triads in this scale' }));
    return;
  }
  els.scaleTriads.replaceChildren(...list.map((tr) => {
    const name = NOTE_NAMES[tr.root] + tr.t.symbol;
    const selected = els.chordType.value === tr.t.id && Number(els.chordRoot.value) === tr.root;
    return el('button', {
      type: 'button',
      className: `triad${selected ? ' selected' : ''}`,
      title: `${capitalize(`${NOTE_NAMES[tr.root]} ${tr.t.name.toLowerCase()}`)} · select`,
      onclick: () => selectChord({ root: tr.root, id: tr.t.id, inv: 0 }),
    },
      tr.numeral ? el('span', { className: 'triad-num', textContent: tr.numeral }) : '',
      el('span', { className: 'triad-name', textContent: name }),
    );
  }));
}

const STEP_LABELS = { 1: 'H', 2: 'W', 3: 'WH', 4: 'WW' };
const STEP_TITLES = { 1: 'Half step (1 semitone)', 2: 'Whole step (2 semitones)', 3: 'Whole + half step (3 semitones)', 4: 'Two whole steps (4 semitones)' };

/** Scale notes in a row, evenly spaced, ending on the octave; under each gap, the step between the two notes. */
function scaleNoteItems(scale, scaleRoot) {
  const items = [];
  scale.steps.forEach((step, i) => {
    items.push(el('li', { className: `scale-note${i === 0 ? ' root' : ''}`, textContent: NOTE_NAMES[(scaleRoot + step) % 12] }));
    const gap = (i + 1 < scale.steps.length ? scale.steps[i + 1] : 12) - step;
    items.push(el('li', { className: 'scale-gap', title: STEP_TITLES[gap] || `${gap} semitones` },
      el('span', { textContent: STEP_LABELS[gap] || String(gap) })));
  });
  items.push(el('li', { className: 'scale-note octave', textContent: NOTE_NAMES[scaleRoot], title: 'Octave' }));
  return items;
}

function onTheoryChange(e) {
  if (e.target === els.chordType) fillInversions('0');
  renderTheory();
  save();
  e.target.blur(); // give the keyboard back to the mapper
}

function playChord() {
  const current = currentChordNotes();
  if (current) preview(current.notes, state.defaultChannel, DEFAULT_VELOCITY, CHORD_PREVIEW_MS);
}

function theoryView() {
  return {
    scaleRoot: els.scaleRoot.value,
    scaleType: els.scaleType.value,
    chordRoot: els.chordRoot.value,
    chordType: els.chordType.value,
    chordInv: els.chordInv.value,
    showBinds: bindsShown(),
    showStd: stdShown(),
  };
}

function applyView(view) {
  if (!view || typeof view !== 'object') return;
  for (const name of ['scaleRoot', 'scaleType', 'chordRoot', 'chordType']) {
    const select = els[name];
    if (typeof view[name] !== 'string') continue;
    select.value = view[name];
    if (select.value !== view[name]) select.selectedIndex = 0; // unknown value
  }
  fillInversions(typeof view.chordInv === 'string' ? view.chordInv : '0');
  if (typeof view.showBinds === 'boolean') setBindsShown(view.showBinds);
  if (typeof view.showStd === 'boolean') setStdShown(view.showStd);
}

function bindsShown() {
  return els.bindsToggle.getAttribute('aria-pressed') === 'true';
}

function setBindsShown(on) {
  els.bindsToggle.setAttribute('aria-pressed', String(on));
  els.piano.classList.toggle('hide-binds', !on);
}

/* ------------------------- chord analysis --------------------------- */

/** "b3" → "♭3", "#5" → "♯5". */
const fmtDegree = (d) => d.replace(/b/g, '♭').replace(/#/g, '♯');
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function intervalName(semis) {
  if (semis < 12) return INTERVAL_NAMES[semis];
  if (COMPOUND_INTERVALS[semis]) return COMPOUND_INTERVALS[semis];
  return `${INTERVAL_NAMES[semis % 12]} + ${Math.floor(semis / 12)} octaves`;
}

function inversionName(degree, template) {
  if (degree === 'R') return 'Root position';
  if (template.steps.length > 2) {
    if (degree === '3' || degree === 'b3') return '1st inversion';
    if (degree === '5' || degree === 'b5' || degree === '#5') return '2nd inversion';
    if (degree === '7' || degree === 'b7' || degree === 'bb7') return '3rd inversion';
  }
  return `${DEGREE_NAMES[degree] || degree} in the bass`;
}

const slashSymbol = (root, t, bass) => `${NOTE_NAMES[root]}${t.symbol}${root === bass ? '' : `/${NOTE_NAMES[bass]}`}`;

/** Every chord type matching these pitch classes, best reading first. */
function matchChords(pcs, bass) {
  const matches = [];
  for (const root of pcs) {
    const key = pcSetKey(pcs.map((pc) => pc - root));
    CHORD_TEMPLATES.forEach((t, rank) => {
      if (t.key === key) matches.push({ root, t, rank });
    });
  }
  // Prefer a root in the bass (root position), then the simplest chord type.
  return matches.sort((a, b) => (a.root !== bass) - (b.root !== bass) || a.rank - b.rank);
}

/** Describe sorted MIDI notes read as chord type `t` on pitch class `root`. */
function analyseChord(sorted, root, t, matches) {
  const bass = sorted[0] % 12;
  const pcs = [...new Set(sorted.map((n) => n % 12))];
  const symbol = slashSymbol(root, t, bass);
  const degreeOf = (n) => t.degreeByPc.get((((n - root) % 12) + 12) % 12);
  const bassDegree = degreeOf(sorted[0]);
  return {
    kind: 'chord',
    notes: sorted,
    bass,
    pcs,
    root,
    template: t,
    symbol,
    fullName: `${NOTE_NAMES[root]} ${t.name.toLowerCase()}`,
    aliases: (CHORD_ALIASES[t.id] || []).map((a) => NOTE_NAMES[root] + a),
    inversion: inversionName(bassDegree, t),
    inversionIndex: Math.max(0, t.degrees.indexOf(bassDegree)),
    formula: t.degrees.map((d) => (d === 'R' ? '1' : fmtDegree(d))).join(' '),
    members: sorted.map((n) => ({ note: n, degree: degreeOf(n) })),
    alternatives: [...new Set(matches.map((m) => slashSymbol(m.root, m.t, bass)))]
      .filter((a) => a !== symbol).slice(0, 3),
  };
}

/** Analyse a set of MIDI notes (any octave, any inversion). */
function detectChord(notes) {
  const sorted = [...new Set(notes)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const bass = sorted[0] % 12;
  const pcs = [...new Set(sorted.map((n) => n % 12))]; // bass-up order
  if (pcs.length === 1) return { kind: 'note', notes: sorted, bass, pcs };
  const matches = matchChords(pcs, bass);
  if (matches.length === 0) return { kind: pcs.length === 2 ? 'interval' : 'unknown', notes: sorted, bass, pcs };
  return analyseChord(sorted, matches[0].root, matches[0].t, matches);
}

/** The chord picked in "Scales & chords", analysed like a played chord. */
function selectedChord() {
  const c = currentChordNotes();
  if (!c) return null;
  const t = CHORD_TEMPLATES.find((x) => x.id === c.chord.id);
  const pcs = [...new Set(c.notes.map((n) => n % 12))];
  return analyseChord(c.notes, c.root % 12, t, matchChords(pcs, c.notes[0] % 12));
}

function currentNotes() {
  return [...state.sounding.keys()].map((k) => Number(k.slice(k.indexOf(':') + 1)));
}

/* -------------------------- chord panel ----------------------------- */

function scheduleDetect() {
  if (state.detectQueued) return;
  state.detectQueued = true;
  requestAnimationFrame(() => {
    state.detectQueued = false;
    updateNowPlaying();
  });
}

function cancelRelease() {
  clearTimeout(state.releaseTimer);
  state.releaseTimer = null;
  state.releaseFrom = null;
}

/**
 * Decide what the chord panel shows:
 * - a chord is selected → that chord, with feedback on what you're playing;
 * - otherwise → live detection. Fingers lifted in quick succession count as one
 *   release, so "Last played" keeps the full chord, not the last finger or two.
 */
function updateNowPlaying() {
  const notes = currentNotes();
  const count = new Set(notes).size;
  const previous = state.lastCount;
  state.lastCount = count;
  const live = detectChord(notes);

  if (count > 0 && count >= previous) queueHistory(live);
  else clearTimeout(state.historyTimer);

  const selected = selectedChord();
  if (selected) {
    cancelRelease();
    if (live && count >= previous) state.npLast = live; // remembered for when you deselect
    state.liveShown = null;
    renderPanel('selected', selected, notes);
    return;
  }

  if (count === 0) {
    const last = state.releaseFrom || state.liveShown || state.npLast;
    cancelRelease();
    state.liveShown = null;
    state.npLast = last;
    renderPanel(last ? 'last' : 'idle', last, notes);
    return;
  }

  if (count < previous && state.liveShown) {
    // Part of a release: keep showing the chord that was held for a moment.
    if (!state.releaseFrom) state.releaseFrom = state.liveShown;
    clearTimeout(state.releaseTimer);
    state.releaseTimer = setTimeout(() => {
      state.releaseTimer = null;
      state.releaseFrom = null;
      updateNowPlaying(); // still holding notes: show what's left
    }, RELEASE_GRACE_MS);
    return;
  }

  cancelRelease();
  state.liveShown = live;
  renderPanel('live', live, notes);
}

/** Play-along feedback while a chord is selected. */
function matchStatus(r, notes) {
  const played = new Set(notes.map((n) => n % 12));
  const wanted = new Set(r.pcs);
  const hit = [...wanted].filter((pc) => played.has(pc)).length;
  const extra = [...played].filter((pc) => !wanted.has(pc));
  if (extra.length) return { text: `Extra ${extra.map((pc) => NOTE_NAMES[pc]).join(' ')}`, cls: 'sel-extra' };
  if (hit === wanted.size) return { text: `✓ ${hit} / ${wanted.size}`, cls: 'sel-match' };
  return { text: `${hit} / ${wanted.size}`, cls: hit ? 'sel-partial' : 'sel' };
}

const chip = (text, className = '') => el('span', { className: `np-chip ${className}`.trim(), textContent: text });
const placeholder = (text) => el('span', { className: 'np-placeholder', textContent: text });

/** Fill the fixed panel slots. Nothing is added or removed, so the layout stays put. */
function renderPanel(mode, r, notes) {
  const selected = mode === 'selected';
  els.npBody.className = `np-body mode-${selected ? 'selected' : 'detect'}${r ? '' : ' empty'}`;
  // Only a selected chord gets a status pill (notes matched); detection shows none.
  els.npState.hidden = !selected;
  if (selected) {
    const status = matchStatus(r, notes);
    els.npState.className = `np-state ${status.cls}`;
    els.npState.textContent = status.text;
    els.npState.title = 'Chord tones being played';
  }
  els.npMode.textContent = selected ? 'Selected' : mode === 'last' ? 'Last detected' : 'Detected';

  if (!r) {
    els.npSymbol.className = 'np-symbol';
    setSymbol('—');
    els.npName.textContent = 'No notes';
    els.npMeta.textContent = 'Chord name and tones appear here.';
    els.npAlt.textContent = '';
    els.npTones.replaceChildren(placeholder('—'));
    state.displaySymbol = null;
    renderHistory();
    renderChordAction(selected, r);
    return;
  }

  const lo = r.notes[0];
  const hi = r.notes[r.notes.length - 1];
  const playedPcs = new Set(notes.map((n) => n % 12));

  // Headline
  let symbol;
  let title;
  const meta = [];
  const alt = [];
  if (r.kind === 'chord') {
    symbol = r.symbol;
    title = capitalize(r.fullName);
    meta.push(r.inversion, `Formula ${r.formula}`);
    if (r.aliases.length) alt.push(`= ${r.aliases.join(', ')}`);
    if (r.alternatives.length) alt.push(`also ${r.alternatives.join(', ')}`);
  } else if (r.kind === 'interval') {
    const semis = hi - lo;
    symbol = `${NOTE_NAMES[lo % 12]}–${NOTE_NAMES[hi % 12]}`;
    title = capitalize(intervalName(semis));
    meta.push(`${semis} semitone${semis === 1 ? '' : 's'}`);
    if (semis > 12) alt.push(`A ${intervalName(semis % 12)} plus ${Math.floor(semis / 12)} octave${semis >= 24 ? 's' : ''}`);
  } else if (r.kind === 'note') {
    symbol = r.notes.length === 1 ? noteName(lo) : NOTE_NAMES[r.bass];
    title = r.notes.length === 1 ? 'Single note' : `${NOTE_NAMES[r.bass]} in ${r.notes.length} octaves`;
    meta.push(r.notes.length === 1 ? `MIDI ${lo}` : r.notes.map(noteName).join(' + '));
  } else {
    symbol = '?';
    title = 'No chord match';
    meta.push(`${r.pcs.length} different notes: ${r.pcs.map((pc) => NOTE_NAMES[pc]).join(' ')}`);
  }
  els.npSymbol.className = `np-symbol ${r.kind}`;
  setSymbol(symbol);
  els.npName.textContent = title;
  els.npMeta.textContent = meta.join('  ·  ');
  els.npAlt.textContent = alt.join('  ·  ');
  els.npAlt.title = r.kind === 'chord'
    ? [r.aliases.length ? `Also written ${r.aliases.join(', ')}` : '', r.alternatives.length ? `Same notes as ${r.alternatives.join(', ')}` : ''].filter(Boolean).join('\n')
    : '';

  // Notes, bass to top: role, interval badge and the keys that play each note
  els.npTonesLabel.textContent = r.kind === 'chord' ? 'Chord tones · bass to top' : 'Notes · bass to top';
  const heldCodes = new Set(state.held.keys());
  els.npTones.replaceChildren(...r.notes.map((n, i) => {
    let degree = '';
    let role;
    if (r.kind === 'chord') {
      degree = r.members.find((x) => x.note === n).degree;
      role = DEGREE_NAMES[degree] || degree;
    } else {
      role = n === lo ? 'Bass' : capitalize(intervalName(n - lo));
    }
    const maps = [...state.mappings.values()].filter((m) => m.note === n);
    const keys = maps.length
      ? maps.slice(0, 2).map((m) => chip(physicalKeyLabel(m), `key${heldCodes.has(m.code) ? ' on' : ''}`))
      : [chip('no key', 'missing')];
    const on = selected && playedPcs.has(n % 12);
    return el('li', {
      className: `np-note${degree === 'R' ? ' root' : ''}${on ? ' on' : ''}`,
      title: i > 0 ? `${intervalName(n - r.notes[i - 1])} above ${noteName(r.notes[i - 1])}` : 'Lowest note',
    },
      el('span', { className: 'np-note-name', textContent: noteName(n) }),
      el('span', { className: 'np-deg', textContent: degree ? fmtDegree(degree) : '' }),
      el('span', { className: 'np-role', textContent: role }),
      el('span', { className: 'np-note-keys' }, ...keys),
    );
  }));

  state.displaySymbol = !selected && r.kind === 'chord' ? r.symbol : null;
  renderHistory();
  renderChordAction(selected, r); // last, so the symbol's class list is final
}

/** Show the chord symbol, shrinking the font until it fits its fixed-size box. */
function setSymbol(text) {
  const box = els.npSymbol;
  if (box.textContent === text && box.dataset.fitted === '1') return;
  box.textContent = text;
  box.style.fontSize = '';
  let size = parseFloat(getComputedStyle(box).fontSize);
  while (box.scrollWidth > box.clientWidth && size > 12) {
    size -= 1;
    box.style.fontSize = `${size}px`;
  }
  box.dataset.fitted = '1';
}

/** Deselect button (enabled with a selection) and the clickable detected-chord card. */
function renderChordAction(selected, r) {
  els.chordAction.disabled = !selected;
  els.chordAction.title = selected ? 'Deselect chord (back to auto-detect)' : 'No chord selected';
  const pickable = !selected && !!r && r.kind === 'chord';
  state.pickChord = pickable ? { root: r.root, id: r.template.id, inv: r.inversionIndex } : null;
  els.npSymbol.classList.toggle('pickable', pickable);
  els.npSymbol.title = pickable ? `Select ${capitalize(r.fullName)}` : '';
}

/* ---- recent chords ---- */

function queueHistory(r) {
  clearTimeout(state.historyTimer);
  if (!r || r.kind !== 'chord') return;
  state.historyTimer = setTimeout(() => {
    const now = detectChord(currentNotes());
    if (!now || now.kind !== 'chord' || now.symbol !== r.symbol) return;
    const last = state.history[state.history.length - 1];
    if (last && last.symbol === r.symbol) return;
    state.history = state.history.filter((h) => h.symbol !== r.symbol);
    state.history.push({
      root: r.root, id: r.template.id, inv: r.inversionIndex, symbol: r.symbol, fullName: r.fullName,
    });
    if (state.history.length > HISTORY_MAX) state.history.shift();
    renderHistory();
  }, HISTORY_SETTLE_MS);
}

function isSelected(h) {
  return els.chordType.value === h.id &&
    Number(els.chordRoot.value) === h.root &&
    Number(els.chordInv.value) === h.inv;
}

function renderHistory() {
  const items = state.history.map((h, i) => el('li', {},
    el('button', {
      type: 'button',
      className: `np-hist${isSelected(h) ? ' selected' : h.symbol === state.displaySymbol ? ' shown' : ''}`,
      textContent: h.symbol,
      title: `${capitalize(h.fullName)} · select`,
      onclick: () => selectChord(h),
    })));
  els.npHistory.replaceChildren(...items);
  els.npHistory.classList.toggle('empty', items.length === 0);
  els.npHistoryClear.disabled = items.length === 0;
}

/** Put a chord (from the history) into the chord picker. */
function selectChord(h) {
  els.chordRoot.value = String(h.root);
  els.chordType.value = h.id;
  fillInversions(String(h.inv));
  renderTheory();
  save();
}

/* ------------------------------ keyboard ---------------------------- */

function onKeyDown(e) {
  // 1) Capturing a new key to map.
  if (state.capturing) {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.key === 'Escape') {
      stopCapture();
      return;
    }
    const code = keyId(e);
    if (!code) {
      addLog('That key cannot be identified by the browser — try another one.', true);
      return;
    }
    stopCapture();
    openDialog(code, keyLabel(e));
    return;
  }

  // 2) Normal play mode.
  if (els.dialog.open || isTypingTarget(e.target)) return;
  if (e.code === 'Space' || e.key === ' ') e.preventDefault(); // never scroll the page
  const code = keyId(e);
  if (!code || !state.mappings.has(code)) return;
  e.preventDefault(); // stop Space scrolling, Tab moving focus, etc.
  if (e.repeat) return;
  pressKey(code);
}

function onKeyUp(e) {
  const code = keyId(e);
  if (state.held.has(code)) {
    e.preventDefault();
    releaseKey(code);
  } else if (state.mappings.has(code) && !els.dialog.open && !isTypingTarget(e.target)) {
    e.preventDefault();
  }
  // macOS does not deliver keyup for other keys while ⌘ is held, so
  // releasing ⌘ releases everything to avoid stuck notes.
  if (e.key === 'Meta') releaseAll();
}

function startCapture() {
  if (state.capturing) {
    stopCapture();
    return;
  }
  releaseAll();
  state.capturing = true;
  els.captureBanner.hidden = false;
  els.addBtn.textContent = 'Listening… (click to cancel)';
  els.addBtn.classList.add('listening');
}

function stopCapture() {
  state.capturing = false;
  els.captureBanner.hidden = true;
  els.addBtn.textContent = '+ Add key';
  els.addBtn.classList.remove('listening');
}

/* ------------------------------ dialog ------------------------------ */

function suggestNote() {
  const used = new Set(
    [...state.mappings.values()]
      .filter((m) => effectiveChannel(m) === state.defaultChannel)
      .map((m) => m.note),
  );
  let n = state.lastNote !== null ? Math.min(127, state.lastNote + 1) : 60;
  while (used.has(n) && n < 127) n++;
  return n;
}

function openDialog(code, label) {
  const existing = state.mappings.get(code);
  state.editing = { code, label: label || (existing && existing.label) || code };

  els.dlgTitle.textContent = existing ? 'Edit mapping' : 'New mapping';
  els.dlgKey.textContent = state.editing.label;
  els.dlgCode.textContent = code;
  els.dlgChannel.options[0].textContent = `Default (ch ${state.defaultChannel})`;
  els.dlgNote.value = String(existing ? existing.note : suggestNote());
  els.dlgChannel.value = existing && existing.channel != null ? String(existing.channel) : '';
  els.dlgVelocity.value = String(existing ? existing.velocity : DEFAULT_VELOCITY);
  els.dlgVelOut.textContent = els.dlgVelocity.value;

  els.dialog.returnValue = '';
  els.dialog.showModal();
  els.dlgNote.focus();
}

function dialogValues() {
  const channel = els.dlgChannel.value === '' ? null : Number(els.dlgChannel.value);
  return {
    note: Number(els.dlgNote.value),
    channel,
    velocity: Number(els.dlgVelocity.value),
  };
}

function previewFromDialog() {
  const v = dialogValues();
  preview(v.note, v.channel ?? state.defaultChannel, v.velocity);
}

function onDialogClose() {
  stopPreview();
  const editing = state.editing;
  state.editing = null;
  if (!editing || els.dialog.returnValue !== 'save') return;

  const v = dialogValues();
  if (state.held.has(editing.code)) releaseKey(editing.code);
  state.mappings.set(editing.code, { code: editing.code, label: editing.label, ...v });
  state.lastNote = v.note;
  render();
  save();
}

/* ------------------------------ table ------------------------------- */

function render() {
  const rows = [];
  const sorted = [...state.mappings.values()].sort((a, b) => a.note - b.note || a.code.localeCompare(b.code));
  for (const m of sorted) {
    const channelCell = m.channel != null
      ? el('td', { textContent: String(m.channel) })
      : el('td', {}, el('span', { className: 'muted', textContent: `Default (${state.defaultChannel})` }));

    const row = el('tr', {},
      el('td', {}, el('kbd', { textContent: m.label }), el('span', { className: 'muted mono key-code', textContent: m.code })),
      el('td', {}, el('span', { className: 'note-name', textContent: noteName(m.note) }), ' ', el('span', { className: 'muted', textContent: String(m.note) })),
      channelCell,
      el('td', { textContent: String(m.velocity) }),
      el('td', { className: 'actions' },
        el('button', { type: 'button', className: 'btn small', textContent: '▶ Test', title: 'Play this note' }),
        el('button', { type: 'button', className: 'btn small', textContent: 'Edit' }),
        el('button', { type: 'button', className: 'btn danger small', textContent: 'Remove' }),
      ),
    );
    const [testBtn, editBtn, removeBtn] = row.querySelectorAll('button');
    testBtn.dataset.action = 'test';
    editBtn.dataset.action = 'edit';
    removeBtn.dataset.action = 'remove';
    row.dataset.code = m.code;
    if (state.held.has(m.code)) row.classList.add('active');
    rows.push(row);
  }
  els.mapBody.replaceChildren(...rows);

  const count = state.mappings.size;
  els.mapTable.hidden = count === 0;
  els.emptyMsg.hidden = count > 0;
  els.mapCount.textContent = count ? `(${count})` : '';
  els.exportBtn.disabled = count === 0;
  els.clearBtn.disabled = count === 0;

  renderPianoBindings();
}

function onTableClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const code = btn.closest('tr').dataset.code;
  const mapping = state.mappings.get(code);
  if (!mapping) return;

  switch (btn.dataset.action) {
    case 'test':
      preview(mapping.note, effectiveChannel(mapping), mapping.velocity);
      break;
    case 'edit':
      openDialog(code, mapping.label);
      break;
    case 'remove':
      releaseKey(code);
      state.mappings.delete(code);
      render();
      save();
      break;
  }
}

/* ------------------------- persistence / files ---------------------- */

function sanitizeMapping(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !raw.code) return null;
  const note = toInt(raw.note, 0, 127);
  if (note === null) return null;
  const velocity = toInt(raw.velocity, 1, 127) ?? DEFAULT_VELOCITY;
  const channel = raw.channel == null || raw.channel === '' ? null : toInt(raw.channel, 1, 16);
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.slice(0, 40) : raw.code;
  return { code: raw.code.slice(0, 64), label, note, channel, velocity };
}

function parseMappingData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.mappings)) return null;
  const mappings = new Map();
  let skipped = 0;
  for (const raw of data.mappings) {
    const m = sanitizeMapping(raw);
    if (m) mappings.set(m.code, m);
    else skipped++;
  }
  const defaultChannel = toInt(data.defaultChannel, 1, 16) ?? 1;
  return { mappings, defaultChannel, skipped };
}

function serialize() {
  return {
    app: FILE_TAG,
    version: FILE_VERSION,
    defaultChannel: state.defaultChannel,
    mappings: [...state.mappings.values()].map(({ code, label, note, channel, velocity }) => (
      { code, label, note, channel, velocity }
    )),
  };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...serialize(),
      outputName: state.preferredOutputName,
      view: theoryView(),
    }));
  } catch {
    /* storage unavailable (private mode, file:// restrictions…) — export still works */
  }
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    const parsed = parseMappingData(data);
    if (parsed) {
      state.mappings = parsed.mappings;
      state.defaultChannel = parsed.defaultChannel;
      const last = [...parsed.mappings.values()].pop();
      state.lastNote = last ? last.note : null;
    }
    if (typeof data.outputName === 'string') state.preferredOutputName = data.outputName;
    if (data.view && typeof data.view === 'object') state.view = data.view;
  } catch {
    /* ignore corrupt storage */
  }
}

function exportMapping() {
  const data = { ...serialize(), exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const a = el('a', { href: url, download: `uniso-keymap-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert(`“${file.name}” is not a valid JSON file.`);
    return;
  }
  const parsed = parseMappingData(data);
  if (!parsed || parsed.mappings.size === 0) {
    alert(`No valid key mappings found in “${file.name}”.`);
    return;
  }
  if (state.mappings.size > 0 &&
      !confirm(`Replace the ${state.mappings.size} current mapping(s) with ${parsed.mappings.size} from “${file.name}”?`)) {
    return;
  }

  releaseAll();
  state.mappings = parsed.mappings;
  state.defaultChannel = parsed.defaultChannel;
  els.channelSelect.value = String(state.defaultChannel);
  const last = [...parsed.mappings.values()].pop();
  state.lastNote = last ? last.note : null;
  render();
  scrollPianoToMappings();
  save();
  addLog(`Imported ${parsed.mappings.size} mapping(s) from ${file.name}` +
    (parsed.skipped ? ` (${parsed.skipped} invalid skipped)` : ''));
}

/* ------------------------------ wiring ------------------------------ */

function bind() {
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // Never leave notes hanging when the page loses focus.
  window.addEventListener('blur', () => {
    releaseAll();
    releasePointerNote();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseAll();
      releasePointerNote();
    }
  });
  window.addEventListener('pagehide', () => {
    releaseAll();
    stopPreview();
    releasePointerNote();
  });

  els.piano.addEventListener('pointerdown', onPianoPointerDown);
  els.stdPiano.addEventListener('pointerdown', onPianoPointerDown);
  window.addEventListener('resize', () => {
    els.npSymbol.dataset.fitted = '';
    setSymbol(els.npSymbol.textContent);
  });
  window.addEventListener('pointerup', releasePointerNote);
  window.addEventListener('pointercancel', releasePointerNote);

  // Keep focus off buttons/selects so Space/Enter go to the mapper, not the UI.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && !els.dialog.contains(btn)) btn.blur();
  });

  els.outputSelect.addEventListener('change', () => {
    const output = state.midi && state.midi.outputs.get(els.outputSelect.value);
    if (output) {
      setOutput(output);
      setStatus(`Sending to “${output.name}”`, 'ok');
    }
    els.outputSelect.blur();
  });

  els.channelSelect.addEventListener('change', () => {
    state.defaultChannel = Number(els.channelSelect.value);
    render();
    save();
    els.channelSelect.blur();
  });

  els.panicBtn.addEventListener('click', panic);
  els.addBtn.addEventListener('click', startCapture);
  els.exportBtn.addEventListener('click', exportMapping);
  els.importBtn.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', () => {
    const file = els.importInput.files && els.importInput.files[0];
    els.importInput.value = ''; // allow re-importing the same file
    if (file) importFile(file);
  });
  els.clearBtn.addEventListener('click', () => {
    if (!confirm(`Remove all ${state.mappings.size} mapping(s)?`)) return;
    releaseAll();
    state.mappings.clear();
    state.lastNote = null;
    render();
    save();
  });
  els.clearLogBtn.addEventListener('click', () => els.log.replaceChildren());

  els.mapBody.addEventListener('click', onTableClick);

  for (const select of [els.scaleRoot, els.scaleType, els.chordRoot, els.chordType, els.chordInv]) {
    select.addEventListener('change', onTheoryChange);
  }
  els.chordPlay.addEventListener('click', playChord);
  els.bindsToggle.addEventListener('click', () => {
    setBindsShown(!bindsShown());
    save();
  });
  els.stdToggle.addEventListener('click', () => {
    setStdShown(!stdShown());
    save();
  });
  els.chordAction.addEventListener('click', () => {
    els.chordType.value = '';
    fillInversions('0');
    renderTheory();
    save();
  });
  els.npSymbol.addEventListener('click', () => {
    if (state.pickChord) selectChord(state.pickChord);
  });
  els.scaleClear.addEventListener('click', () => {
    els.scaleType.value = '';
    renderTheory();
    save();
  });
  els.npHistoryClear.addEventListener('click', () => {
    state.history = [];
    renderHistory();
  });

  els.dlgNote.addEventListener('change', previewFromDialog);
  els.dlgPreview.addEventListener('click', previewFromDialog);
  els.dlgVelocity.addEventListener('input', () => {
    els.dlgVelOut.textContent = els.dlgVelocity.value;
  });
  els.dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      els.dialog.close('save');
    }
  });
  els.dialog.addEventListener('close', onDialogClose);
}

function init() {
  fillNoteSelect(els.dlgNote);
  fillChannelSelect(els.channelSelect, false);
  fillChannelSelect(els.dlgChannel, true);
  buildPiano();
  buildStdPiano();
  fillTheorySelects();
  load();
  applyView(state.view);
  els.channelSelect.value = String(state.defaultChannel);
  render();
  renderTheory();
  scrollPianoToMappings();
  bind();
  initMidi();
}

init();
