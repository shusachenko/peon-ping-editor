'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readHistory, parseLine } = require('../src/history');

// Lines as peon-ping 2.37 writes them
const LOG = `2026-10-26T10:00:00.001 [config] inv=a1 loaded=/x/config.json volume=0.5 pack=peon enabled=True
2026-10-26T10:00:00.002 [hook] inv=a1 event=Stop session=s1 cwd=/Users/me/work/api paused=False
2026-10-26T10:00:00.010 [route] inv=a1 category=task.complete suppressed=False reason=""
2026-10-26T10:00:00.011 [sound] inv=a1 file=WorkWork.wav pack=peon candidates=5 no_repeat=True
2026-10-26T10:00:00.040 [notify] inv=a1 desktop=True mobile=False template="" rendered="done"
2026-10-26T10:00:00.041 [exit] inv=a1 duration_ms=40 exit=0
2026-10-26T10:00:00.200 [notify] inv=a1 dispatch event=Stop focused=false style=overlay cmux_standard=false
2026-10-26T10:00:00.300 [play] inv=a1 backend=mac file=WorkWork.wav volume=0.5 async=true
2026-10-26T10:05:00.002 [hook] inv=b2 event=Stop session=s2 cwd=/Users/me/Downloads paused=False
2026-10-26T10:05:00.003 [route] inv=b2 category=none suppressed=True reason=excluded_dir pattern=/Users/me/Downloads
2026-10-26T10:09:00.002 [hook] inv=c3 event=PermissionRequest session=s1 cwd=/Users/me/work/api paused=True
2026-10-26T10:09:00.010 [route] inv=c3 category=input.required suppressed=False reason=""
2026-10-26T10:09:00.011 [sound] inv=c3 file=What.wav pack=peon candidates=4 no_repeat=True
2026-10-26T10:09:00.040 [notify] inv=c3 desktop=True mobile=False template="" rendered="needs approval: Bash"
2026-10-26T10:12:00.002 [hook] inv=d4 event=Stop session=s1 cwd=/Users/me/work/api paused=False
2026-10-26T10:12:00.010 [route] inv=d4 category=task.complete suppressed=False reason=""
2026-10-26T10:12:00.011 [sound] inv=d4 file=Done.wav pack=peon candidates=5 no_repeat=True
garbage line that is not from peon-ping
`;

test('parses key=value pairs, including quoted values', () => {
  const l = parseLine('2026-10-26T10:00:00.040 [notify] inv=a1 desktop=True rendered="needs approval: Bash" template=""');
  assert.equal(l.phase, 'notify');
  assert.equal(l.fields.rendered, 'needs approval: Bash');
  assert.equal(l.fields.template, '');
  assert.equal(parseLine('nope'), null);
});

test('turns the log into events with what happened and why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peon-history-'));
  fs.writeFileSync(path.join(dir, 'peon-ping-2026-10-26.log'), LOG);
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
  const h = readHistory(dir);
  assert.deepEqual(h.map((e) => e.id), ['d4', 'c3', 'b2', 'a1']); // newest first
  const [quiet, muted, silent, played] = h;
  assert.equal(played.status, 'played');
  assert.equal(played.project, 'api');
  assert.equal(played.file, 'WorkWork.wav');
  assert.equal(played.popup, true);
  assert.equal(played.message, 'done');
  assert.equal(silent.status, 'skipped');
  assert.equal(silent.why, 'Silent folder');
  assert.equal(muted.why, 'Sounds were muted');
  assert.match(quiet.why, /quiet mode/i);
  assert.deepEqual(readHistory(path.join(dir, 'missing')), []);
});
