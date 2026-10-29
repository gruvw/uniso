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
const PIANO_FIRST = 12; // C0 (C4 = MIDI 60)
const PIANO_LAST = 95;  // B6
const KEY_SYMBOLS = {
  Shift: '⇧', Control: 'Ctrl', Alt: 'Alt', AltGraph: 'AltGr', Meta: '⌘',
  Enter: '⏎', Backspace: '⌫', Tab: '⇥', Space: '␣', Escape: 'Esc', CapsLock: '⇪',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Delete: 'Del', Insert: 'Ins', PageUp: 'PgUp', PageDown: 'PgDn', ContextMenu: 'Menu',
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
  preview: null,              // { note, channel, timer }
  pointerNote: null,          // { note, channel } while a piano key is clicked
  lastNote: null,
};

const pianoKeys = new Map();  // note -> piano key element

const $ = (id) => document.getElementById(id);
const els = {
  status: $('midiStatus'),
  outputSelect: $('outputSelect'),
  channelSelect: $('channelSelect'),
  panicBtn: $('panicBtn'),
  help: $('help'),
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
  pianoScroll: $('pianoScroll'),
  pianoInfo: $('pianoInfo'),
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
    setStatus('No MIDI output ports — create a virtual port (see help below).', 'warn');
    els.help.open = true;
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
}

function panic() {
  releaseAll();
  stopPreview();
  releasePointerNote();
  state.sounding.clear();
  for (const key of pianoKeys.values()) key.classList.remove('active');
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

function preview(note, channel, velocity) {
  stopPreview();
  startVoice(note, channel, velocity);
  state.preview = { note, channel, timer: setTimeout(stopPreview, PREVIEW_MS) };
}

function stopPreview() {
  const p = state.preview;
  if (!p) return;
  clearTimeout(p.timer);
  state.preview = null;
  stopVoice(p.note, p.channel);
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
    if (!isWhite) {
      // Centered on the boundary to the right of the white key one semitone below.
      const whiteIndex = (n - 1 - PIANO_FIRST) / 2;
      key.style.left = `calc(${whiteIndex + 1} * var(--wk) - var(--bk) / 2)`;
    }
    key.dataset.note = String(n);
    pianoKeys.set(n, key);
    (isWhite ? whites : blacks).push(key);
  }
  els.piano.style.setProperty('--white-count', String(whites.length));
  els.piano.replaceChildren(...whites, ...blacks);
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
  let outside = 0;
  for (const m of state.mappings.values()) {
    if (!pianoKeys.has(m.note)) {
      outside++;
      continue;
    }
    if (!byNote.has(m.note)) byNote.set(m.note, []);
    byNote.get(m.note).push(m);
  }

  for (const [note, key] of pianoKeys) {
    const list = byNote.get(note) || [];
    const chips = list.slice(0, 2).map((m) => el('span', { className: 'pk-bind', textContent: physicalKeyLabel(m) }));
    if (list.length > 2) chips.push(el('span', { className: 'pk-more', textContent: `+${list.length - 2}` }));
    key.firstElementChild.replaceChildren(...chips);
    key.classList.toggle('mapped', list.length > 0);
    key.title = `${noteName(note)} · MIDI ${note} · ` +
      (list.length ? list.map((m) => `physical key ${physicalKeyLabel(m)} (${m.code}, types “${m.label}”)`).join(', ') : 'not mapped');
  }

  const shown = state.mappings.size - outside;
  els.pianoInfo.textContent =
    `${shown} mapped key${shown === 1 ? '' : 's'} shown` +
    (outside ? ` · ${outside} outside C0–B6` : '') +
    ' · click a key to play it';
}

function noteSounding(note) {
  for (const k of state.sounding.keys()) {
    if (Number(k.slice(k.indexOf(':') + 1)) === note) return true;
  }
  return false;
}

function updatePianoNote(note) {
  const key = pianoKeys.get(note);
  if (key) key.classList.toggle('active', noteSounding(note));
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
  for (const m of state.mappings.values()) {
    const channelCell = m.channel != null
      ? el('td', { textContent: String(m.channel) })
      : el('td', {}, el('span', { className: 'muted', textContent: `Default (${state.defaultChannel})` }));

    const row = el('tr', {},
      el('td', {}, el('kbd', { textContent: m.label }), ' ', el('span', { className: 'muted mono', textContent: m.code })),
      el('td', {}, el('span', { className: 'note-name', textContent: noteName(m.note) }), ' ', el('span', { className: 'muted', textContent: String(m.note) })),
      channelCell,
      el('td', { textContent: String(m.velocity) }),
      el('td', { className: 'actions' },
        el('button', { type: 'button', className: 'btn secondary small', textContent: '▶ Test', title: 'Play this note' }),
        el('button', { type: 'button', className: 'btn secondary small', textContent: 'Edit' }),
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...serialize(), outputName: state.preferredOutputName }));
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
  const a = el('a', { href: url, download: `keyboard-midi-mapping-${stamp}.json` });
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
      !confirm(`Replace your ${state.mappings.size} current mapping(s) with ${parsed.mappings.size} from “${file.name}”?`)) {
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
  load();
  els.channelSelect.value = String(state.defaultChannel);
  render();
  scrollPianoToMappings();
  bind();
  initMidi();
}

init();
