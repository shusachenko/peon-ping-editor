'use strict';

// History: what peon-ping did for each event, read from its own debug log (peon debug on).
// One hook call writes several lines with the same inv=<id>: [hook] what happened, [route] which event and
// whether it was suppressed, [sound] the line it picked, [play] only if the sound actually played, [notify]
// the pop-up. A picked sound with no [play] means a quiet mode or the mute stopped it at the last step.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LINE = /^(\S+) \[(\w+)\] inv=(\w+)(.*)$/;
const PAIR = /(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g;
const MAX_BYTES = 4 * 1024 * 1024; // read at most the newest 4 MB of logs

// peon-ping's reasons, in words
const REASONS = {
  paused: 'Sounds were muted',
  excluded_dir: 'Silent folder',
  category_disabled: 'Event switched off',
  debounce_5s: 'Same event again within 5 s',
  replay_suppression: 'Repeat of an event already handled',
  idle_prompt_repeat: 'Still waiting — not repeated',
  session_start_cooldown: 'Another session started moments ago',
  compact_source: 'Session resumed after compacting',
  session_end_cleanup: 'Session ended',
  non_bash_tool_failure: 'Tool failure not worth a sound',
  subagent_stop_suppressed: 'Sub-agent finished',
  subagent_event: 'Sub-agent event',
  subagent_session: 'Sub-agent session',
  subagent_start: 'Sub-agent started',
  agent_session: 'Agent session',
  delegate_mode: 'Delegated session',
  unknown_event: 'Event peon-ping does not handle',
  unknown_notification: 'Notification peon-ping does not handle',
};

function unquote(v) {
  if (!v.startsWith('"')) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v.slice(1, -1);
  }
}

function parseLine(line) {
  const m = line.match(LINE);
  if (!m) return null;
  const fields = {};
  for (const [, k, v] of m[4].matchAll(PAIR)) fields[k] = unquote(v);
  return { ts: m[1], phase: m[2], inv: m[3], fields };
}

const tilde = (p) => (p && p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p || '');

function summarize(lines) {
  const by = (phase) => lines.filter((l) => l.phase === phase);
  const hook = by('hook')[0];
  if (!hook) return null;
  const route = by('route')[0];
  const sound = by('sound')[0];
  const played = by('play').some((l) => !l.fields.error);
  const notifyLines = by('notify');
  const cwd = hook.fields.cwd || '';
  const suppressed = route && route.fields.suppressed === 'True';
  const reason = route && route.fields.reason;
  let outcome;
  if (suppressed) outcome = { status: 'skipped', why: REASONS[reason] || reason || 'Skipped by peon-ping' };
  else if (!route || route.fields.category === 'none') outcome = { status: 'none', why: 'No sound for this event' };
  else if (sound && played) outcome = { status: 'played', why: '' };
  else if (sound && Date.now() - new Date(hook.ts).getTime() < 5000) outcome = { status: 'pending', why: 'Just now — still playing' };
  else if (sound && hook.fields.paused === 'True') outcome = { status: 'skipped', why: 'Sounds were muted' };
  else if (sound) outcome = { status: 'skipped', why: 'A quiet mode: call, Focus, headphones or tab in front' };
  else outcome = { status: 'skipped', why: 'No sound in the pack for this event' };
  return {
    id: hook.inv,
    time: hook.ts,
    event: hook.fields.event || '',
    category: route ? route.fields.category : '',
    project: cwd ? path.basename(cwd) : '',
    cwd: tilde(cwd),
    pack: sound ? sound.fields.pack : '',
    file: sound ? sound.fields.file : '',
    popup: false,
    message: (notifyLines.find((l) => 'rendered' in l.fields) || { fields: {} }).fields.rendered || '',
    ...outcome,
  };
}

function readHistory(logDir, { limit = 200 } = {}) {
  if (!fs.existsSync(logDir)) return [];
  const files = fs.readdirSync(logDir).filter((f) => /^peon-ping-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse();
  const chunks = [];
  let budget = MAX_BYTES;
  for (const f of files) {
    if (budget <= 0) break;
    const full = path.join(logDir, f);
    const size = fs.statSync(full).size;
    const start = Math.max(0, size - budget);
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    budget -= buf.length;
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop a cut-off first line
    chunks.unshift(text);
  }
  const groups = new Map();
  for (const raw of chunks.join('\n').split('\n')) {
    const l = parseLine(raw);
    if (!l) continue;
    l.raw = raw;
    if (!groups.has(l.inv)) groups.set(l.inv, []);
    groups.get(l.inv).push(l);
  }
  const out = [];
  for (const lines of groups.values()) {
    const s = summarize(lines);
    if (s) {
      // The bash side logs "[notify] inv=… dispatch event=…" when a pop-up is actually shown
      s.popup = lines.some((l) => l.phase === 'notify' && / dispatch /.test(l.raw));
      out.push(s);
    }
  }
  out.sort((a, b) => (a.time < b.time ? 1 : -1));
  return out.slice(0, limit);
}

module.exports = { readHistory, parseLine, REASONS };
