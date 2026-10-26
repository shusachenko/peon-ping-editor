'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPeon } = require('../src/peon');
const { createHealth, isNewer } = require('../src/health');

function world({ hooks = ['SessionStart', 'Stop', 'Notification', 'PermissionRequest', 'UserPromptSubmit'], config = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peon-health-'));
  const peonDir = path.join(home, '.claude', 'hooks', 'peon-ping');
  const pack = path.join(peonDir, 'packs', 'demo');
  fs.mkdirSync(path.join(pack, 'sounds'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'sounds', 'hi.wav'), 'RIFF');
  fs.writeFileSync(path.join(pack, 'openpeon.json'), JSON.stringify({ display_name: 'Demo', categories: { 'task.complete': { sounds: [{ file: 'sounds/hi.wav' }, { file: 'sounds/gone.wav' }] } } }));
  fs.writeFileSync(path.join(peonDir, 'peon.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(peonDir, 'VERSION'), '2.0.0\n');
  fs.writeFileSync(path.join(peonDir, 'config.json'), JSON.stringify({ default_pack: 'demo', volume: 0.5, ...config }));
  const hookCfg = Object.fromEntries(hooks.map((h) => [h, [{ hooks: [{ type: 'command', command: `bash ${peonDir}/peon.sh` }] }]]));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: hookCfg }));
  const peon = createPeon({ peonDir, packsDir: path.join(peonDir, 'packs'), configPath: path.join(peonDir, 'config.json'), movesPath: path.join(home, 'm.json'), peonBin: '' });
  const health = createHealth(peon, { home, platform: 'linux', fetchText: async (url) => (url.endsWith('VERSION') ? '2.1.0\n' : '{"version":"99.0.0"}') });
  return { home, peonDir, peon, health, byId: async () => Object.fromEntries((await health.run()).map((c) => [c.id, c])) };
}

test('version compare', () => {
  assert.equal(isNewer('2.10.0', '2.9.9'), true);
  assert.equal(isNewer('0.4.0', '0.4.0-tts.1'), false);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
});

test('a healthy setup reports ok, plus available updates', async () => {
  const { byId } = world();
  const c = await byId();
  assert.equal(c['hooks-claude'].status, 'ok');
  assert.equal(c.muted.status, 'ok');
  assert.equal(c['default-pack'].status, 'ok');
  assert.equal(c.peon.status, 'info'); // 2.1.0 available
  assert.equal(c.editor.status, 'info'); // 99.0.0 available
  assert.equal(c['files-demo'].status, 'warn'); // gone.wav never downloaded
  assert.equal(c['files-demo'].fix.id, 'reinstall:demo');
});

test('finds the usual reasons for silence and fixes them', async () => {
  const { byId, health, peonDir } = world({ hooks: ['SessionStart'], config: { volume: 0, default_pack: 'nope', ide_rules: [{ ide: 'cursor', pack: 'removed' }] } });
  fs.writeFileSync(path.join(peonDir, '.paused'), '');
  let c = await byId();
  assert.equal(c['hooks-claude'].status, 'error');
  assert.match(c['hooks-claude'].detail, /Stop/);
  assert.ok(c['hooks-claude'].command.includes('install.sh'));
  assert.equal(c.muted.status, 'warn');
  assert.equal(c.volume.status, 'warn');
  assert.equal(c['default-pack'].status, 'error');
  assert.equal(c.stale.status, 'warn');

  for (const id of ['unmute', 'volume', 'default-pack', 'stale']) assert.equal((await health.fix(id)).ok, true, id);
  c = await byId();
  assert.equal(c.muted.status, 'ok');
  assert.equal(c.volume.status, 'ok');
  assert.equal(c['default-pack'].status, 'ok');
  assert.equal(c.stale, undefined);
  assert.equal((await health.fix('nonsense')).ok, false);
});

test('missing peon-ping stops early with the install command', async () => {
  const { health, peonDir } = world();
  fs.rmSync(path.join(peonDir, 'peon.sh'));
  const checks = await health.run();
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'error');
  assert.ok(checks[0].command.includes('PeonPing/peon-ping'));
});
