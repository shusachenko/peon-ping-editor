'use strict';

// Health: everything that has to be right for peon-ping to make a sound, checked in one go.
// Each check is { id, group, title, status: ok|warn|error|info, detail, fix?: { id, label }, command? }.
// Fixes only change things the editor already manages; anything bigger is shown as a command to run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PEON_INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash';
const EDITOR_REPO_RAW = 'https://raw.githubusercontent.com/shusachenko/peon-ping-editor/main/package.json';
const PEON_VERSION_RAW = 'https://raw.githubusercontent.com/PeonPing/peon-ping/main/VERSION';
// Without these Claude Code never calls peon-ping for the events people notice
const KEY_HOOKS = ['SessionStart', 'Stop', 'Notification', 'PermissionRequest', 'UserPromptSubmit'];
const LATEST_TTL_MS = 6 * 3600 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Paths as ~/… so screenshots and shared reports do not carry the user name
const tilde = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

function isNewer(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function createHealth(peon, { home = os.homedir(), platform = process.platform, fetchText = defaultFetchText } = {}) {
  const { peonDir, configPath, packsDir } = peon.paths;
  const latest = { at: 0, peon: null, editor: null };

  async function latestVersions() {
    if (Date.now() - latest.at < LATEST_TTL_MS) return latest;
    const [p, e] = await Promise.allSettled([fetchText(PEON_VERSION_RAW), fetchText(EDITOR_REPO_RAW)]);
    latest.peon = p.status === 'fulfilled' ? p.value.trim() : null;
    latest.editor = e.status === 'fulfilled' ? (JSON.parse(e.value).version || null) : null;
    latest.at = Date.now();
    return latest;
  }

  function hookEvents() {
    const settings = readJson(path.join(home, '.claude', 'settings.json'), null);
    if (!settings) return null;
    const events = new Set();
    for (const [event, entries] of Object.entries(settings.hooks || {})) {
      if (JSON.stringify(entries).includes('peon')) events.add(event);
    }
    return events;
  }

  function peonbarState() {
    const app = path.join(home, 'Applications', 'PeonBar.app');
    const installed = fs.existsSync(app);
    const running = spawnSync('/usr/bin/pgrep', ['-x', 'PeonBar']).status === 0;
    const atLogin = fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.peonping.peonbar.plist'));
    return { app, installed, running, atLogin };
  }

  async function run({ network = true } = {}) {
    const checks = [];
    const add = (c) => checks.push(c);
    const cfg = readJson(configPath, {});
    const packs = peon.installedPacks();
    const version = fs.existsSync(path.join(peonDir, 'VERSION')) ? fs.readFileSync(path.join(peonDir, 'VERSION'), 'utf8').trim() : '';
    const versions = network ? await latestVersions().catch(() => latest) : latest;

    // ---- peon-ping itself
    if (!fs.existsSync(path.join(peonDir, 'peon.sh'))) {
      add({ id: 'peon', group: 'peon-ping', title: 'peon-ping is not installed', status: 'error', detail: `Nothing at ${tilde(peonDir)}.`, command: PEON_INSTALL_CMD });
      return checks;
    }
    if (versions.peon && version && isNewer(versions.peon, version)) {
      add({ id: 'peon', group: 'peon-ping', title: `peon-ping ${version} — ${versions.peon} is available`, status: 'info', detail: 'Re-running the peon-ping installer updates it and keeps your settings.', command: PEON_INSTALL_CMD });
    } else {
      add({ id: 'peon', group: 'peon-ping', title: `peon-ping ${version || '(unknown version)'}`, status: 'ok', detail: tilde(peonDir) });
    }
    const py = spawnSync('python3', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` }, timeout: 10000 });
    if (py.status === 0) {
      add({ id: 'python', group: 'peon-ping', title: (py.stdout || py.stderr).trim(), status: 'ok', detail: 'peon-ping runs its logic in Python.' });
    } else {
      add({ id: 'python', group: 'peon-ping', title: 'Python 3 is missing', status: 'error', detail: 'peon-ping needs python3 for every sound. Install the Command Line Tools or Homebrew Python.', command: 'xcode-select --install' });
    }

    // ---- hooks: is peon-ping called at all?
    const events = hookEvents();
    if (!events) {
      add({ id: 'hooks-claude', group: 'Hooks', title: 'Claude Code settings not found', status: 'warn', detail: '~/.claude/settings.json is missing, so Claude Code does not call peon-ping.', command: PEON_INSTALL_CMD });
    } else {
      const missing = KEY_HOOKS.filter((e) => !events.has(e));
      add(missing.length
        ? { id: 'hooks-claude', group: 'Hooks', title: `Claude Code: ${missing.length} hook${missing.length === 1 ? '' : 's'} missing`, status: 'error', detail: `peon-ping is not called on ${missing.join(', ')}. Re-run the peon-ping installer to register them.`, command: PEON_INSTALL_CMD }
        : { id: 'hooks-claude', group: 'Hooks', title: `Claude Code: ${events.size} hooks registered`, status: 'ok', detail: 'Start, prompt, done, permission and notification events reach peon-ping.' });
    }
    if (fs.existsSync(path.join(home, '.cursor'))) {
      const cursor = fs.existsSync(path.join(home, '.cursor', 'hooks.json')) && fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8').includes('peon');
      add({ id: 'hooks-cursor', group: 'Hooks', title: cursor ? 'Cursor: hooks registered' : 'Cursor: no peon-ping hooks', status: cursor ? 'ok' : 'warn', detail: cursor ? 'Cursor also reads the Claude Code hooks when third-party skills are on.' : 'Re-run the peon-ping installer with Cursor installed.', command: cursor ? undefined : PEON_INSTALL_CMD });
    }
    if (fs.existsSync(path.join(home, '.copilot'))) {
      const copilot = fs.existsSync(path.join(home, '.copilot', 'hooks', 'peon-ping.json'));
      add({ id: 'hooks-copilot', group: 'Hooks', title: copilot ? 'GitHub Copilot CLI: hooks registered' : 'GitHub Copilot CLI: no peon-ping hooks', status: copilot ? 'ok' : 'warn', detail: copilot ? '~/.copilot/hooks/peon-ping.json' : 'Re-run the peon-ping installer with Copilot CLI installed.', command: copilot ? undefined : PEON_INSTALL_CMD });
    }

    // ---- sound
    const paused = fs.existsSync(path.join(peonDir, '.paused'));
    add(paused
      ? { id: 'muted', group: 'Sound', title: 'Sounds are muted', status: 'warn', detail: 'Nothing plays until you turn sounds back on.', fix: { id: 'unmute', label: 'Turn sounds on' } }
      : { id: 'muted', group: 'Sound', title: 'Sounds are on', status: 'ok' });
    const volume = typeof cfg.volume === 'number' ? cfg.volume : 0.5;
    if (volume <= 0.02) add({ id: 'volume', group: 'Sound', title: 'Volume is at 0%', status: 'warn', detail: 'Sounds play, but you will not hear them.', fix: { id: 'volume', label: 'Set to 50%' } });
    else add({ id: 'volume', group: 'Sound', title: `Volume ${Math.round(volume * 100)}%`, status: 'ok' });
    const flags = cfg.categories || {};
    if (['session.start', 'task.complete', 'input.required', 'task.error'].every((c) => flags[c] === false)) {
      add({ id: 'events', group: 'Sound', title: 'All the main events are switched off', status: 'warn', detail: 'Session start, Task done, Needs your input and Error are all off.', fix: { id: 'events', label: 'Turn them on' } });
    }
    if (platform === 'darwin' && !fs.existsSync('/usr/bin/afplay')) add({ id: 'player', group: 'Sound', title: 'afplay is missing', status: 'error', detail: 'peon-ping plays sounds with /usr/bin/afplay.' });

    // ---- packs
    const defaultPack = cfg.default_pack || cfg.active_pack || 'peon';
    if (!packs.length) {
      add({ id: 'default-pack', group: 'Packs', title: 'No sound packs installed', status: 'error', detail: 'Install one from Get packs.' });
    } else if (!packs.includes(defaultPack)) {
      add({ id: 'default-pack', group: 'Packs', title: `Default pack “${defaultPack}” is not installed`, status: 'error', detail: 'Tools without their own pack have nothing to play.', fix: { id: 'default-pack', label: `Use ${packs[0]}` } });
    } else {
      add({ id: 'default-pack', group: 'Packs', title: `Default pack: ${(peon.listPacks().find((p) => p.name === defaultPack) || {}).display_name || defaultPack}`, status: 'ok' });
    }
    const stale = [
      ...(cfg.ide_rules || []).filter((r) => r.pack && !packs.includes(r.pack)).map((r) => `${r.ide} → ${r.pack}`),
      ...(cfg.path_rules || []).filter((r) => r.pack && !packs.includes(r.pack)).map((r) => `${r.pattern} → ${r.pack}`),
    ];
    if (stale.length) add({ id: 'stale', group: 'Packs', title: `${stale.length} binding${stale.length === 1 ? '' : 's'} to removed packs`, status: 'warn', detail: `${stale.join(', ')}. These play the default pack instead.`, fix: { id: 'stale', label: 'Remove them' } });
    const broken = [];
    for (const pack of packs) {
      const state = peon.packState(pack);
      const missing = new Set();
      for (const cat of (state && state.categories) || []) for (const s of cat.sounds) if (s.missing) missing.add(s.file);
      if (missing.size) broken.push({ pack, name: state.display_name, count: missing.size, custom: state.custom });
    }
    for (const b of broken) {
      add({ id: `files-${b.pack}`, group: 'Packs', title: `${b.name}: ${b.count} sound file${b.count === 1 ? '' : 's'} missing`, status: 'warn', detail: b.custom ? 'Remove them from the pack, or add them again.' : 'They never finished downloading. Reinstalling fetches them again; your edits stay.', fix: b.custom ? undefined : { id: `reinstall:${b.pack}`, label: 'Download again' } });
    }
    if (!broken.length && packs.length) add({ id: 'files', group: 'Packs', title: 'All sound files are present', status: 'ok' });

    // ---- notifications
    if (cfg.desktop_notifications === false) add({ id: 'popups', group: 'Notifications', title: 'Pop-ups are off', status: 'info', detail: 'Sounds still play. Turn pop-ups on in Notifications if you want banners.' });
    const theme = cfg.overlay_theme;
    if (platform === 'darwin' && ['glass', 'sakura', 'jarvis'].includes(theme) && cfg.notification_style !== 'standard' && !fs.existsSync(path.join(peonDir, 'scripts', `mac-overlay-${theme}.js`))) {
      add({ id: 'theme', group: 'Notifications', title: `The ${theme} banner theme is not downloaded`, status: 'warn', detail: 'peon-ping falls back to the classic banner.', fix: { id: 'theme', label: 'Download it' } });
    }
    if (String(cfg.focus_detect).toLowerCase() === 'true') {
      add({ id: 'focus', group: 'Notifications', title: 'Focus detection needs Full Disk Access', status: 'info', detail: 'Give Full Disk Access to the app your agent runs in (Terminal, iTerm, Cursor…). It cannot be checked from here.' });
    }

    // ---- PeonBar
    if (platform === 'darwin') {
      const bar = peonbarState();
      if (!bar.installed) add({ id: 'peonbar', group: 'PeonBar', title: 'PeonBar is not installed', status: 'info', detail: 'The menu-bar switch comes with the editor installer.', command: 'curl -fsSL https://raw.githubusercontent.com/shusachenko/peon-ping-editor/main/install.sh | bash' });
      else if (!bar.running) add({ id: 'peonbar', group: 'PeonBar', title: 'PeonBar is not running', status: 'warn', detail: 'Without it the menu-bar switch, the hotkey and “stop sound on close” do nothing.', fix: { id: 'peonbar', label: 'Start PeonBar' } });
      else add({ id: 'peonbar', group: 'PeonBar', title: bar.atLogin ? 'PeonBar is running and starts at login' : 'PeonBar is running (not at login)', status: bar.atLogin ? 'ok' : 'info', detail: bar.atLogin ? '' : 'Turn on PeonBar → Start at login.' });
    }

    // ---- this editor
    const mine = require('../package.json').version;
    if (versions.editor && isNewer(versions.editor, mine)) add({ id: 'editor', group: 'Editor', title: `peon-ping editor ${mine} — ${versions.editor} is available`, status: 'info', detail: 'PeonBar → Check for Updates installs it.', command: 'curl -fsSL https://raw.githubusercontent.com/shusachenko/peon-ping-editor/main/install.sh | bash' });
    else add({ id: 'editor', group: 'Editor', title: `peon-ping editor ${mine}`, status: 'ok', detail: `Node ${process.versions.node}` });

    return checks;
  }

  async function fix(id) {
    const cfg = readJson(configPath, {});
    const packs = peon.installedPacks();
    if (id === 'unmute') return peon.setSoundsOn(true);
    if (id === 'volume') return peon.setVolume(0.5);
    if (id === 'events') {
      for (const c of ['session.start', 'task.complete', 'input.required', 'task.error']) peon.setEvent(c, true);
      return { ok: true, message: 'Main events are on' };
    }
    if (id === 'default-pack') return packs.length ? peon.setDefaultPack(packs[0]) : { ok: false, message: 'Install a pack first' };
    if (id === 'stale') {
      for (const r of cfg.ide_rules || []) if (r.pack && !packs.includes(r.pack)) peon.bindTool(r.ide, '');
      for (const r of cfg.path_rules || []) if (r.pack && !packs.includes(r.pack)) peon.unbindFolder(r.pattern);
      return { ok: true, message: 'Removed bindings to removed packs' };
    }
    if (id.startsWith('reinstall:')) return peon.installPack(id.slice('reinstall:'.length));
    if (id === 'theme') return peon.setNotifications({ theme: cfg.overlay_theme });
    if (id === 'peonbar' && platform === 'darwin') {
      const r = spawnSync('/usr/bin/open', [path.join(home, 'Applications', 'PeonBar.app')]);
      return { ok: r.status === 0, message: r.status === 0 ? 'PeonBar started' : 'Could not start PeonBar' };
    }
    return { ok: false, message: 'Nothing to fix' };
  }

  // One line from the default pack through afplay, ignoring mute: proves audio reaches the speakers
  function testSound() {
    const cfg = readJson(configPath, {});
    const pack = cfg.default_pack || cfg.active_pack || 'peon';
    const state = peon.packState(pack);
    if (!state) return { ok: false, message: `Default pack “${pack}” is not installed` };
    let file = null;
    for (const cat of ['task.complete', 'session.start', 'input.required']) {
      const c = state.categories.find((x) => x.name === cat);
      const s = c && c.sounds.find((x) => !x.missing);
      if (s) { file = peon.resolveAudio(pack, s.path); break; }
    }
    if (!file) return { ok: false, message: 'The default pack has no playable sound' };
    if (platform !== 'darwin') return { ok: false, message: 'Test sound is macOS only' };
    const vol = Math.max(0.1, typeof cfg.volume === 'number' ? cfg.volume : 0.5);
    spawn('/usr/bin/afplay', ['-v', String(vol), file], { stdio: 'ignore', detached: true }).unref();
    return { ok: true, message: `Playing ${path.basename(file)} at ${Math.round(vol * 100)}%` };
  }

  return { run, fix, testSound };
}

async function defaultFetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

module.exports = { createHealth, isNewer, KEY_HOOKS };
