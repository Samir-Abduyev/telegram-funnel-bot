// `npm run forever` — keeps the bot running on a PC: starts src/main.js, and if it crashes, restarts it and tells the
// owner in Telegram WHY (exit code + last log lines). Exit 0 (Ctrl+C) = stop; exit 78 (wrong .env, revoked token,
// second copy) = stop and tell the owner (restarting would not help). On a VPS systemd does the same job.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api } from 'grammy';
import { loadConfig } from '../src/config.js';
import { createAlerter } from '../src/alerts.js';
import { redactSecrets } from '../src/util.js';

const BOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const EXIT_CONFIG = 78;
const KEEP_LINES = 12;
const BACKOFF_S = [5, 10, 30, 60];
const STABLE_MS = 5 * 60 * 1000; // ran this long → the next crash starts the backoff from the beginning

const { cfg, errors } = loadConfig();
if (errors.length) { console.error('Ошибки в .env:\n - ' + errors.join('\n - ')); process.exit(1); }
const owner = createAlerter((text) => new Api(cfg.token).sendMessage(cfg.ownerId, text, { parse_mode: 'HTML' }));

let stopping = false;
let child = null;
let crashes = 0;
// Stop: let the bot shut down gracefully (it records «stopped by hand» for the next start report). On Windows
// child.kill() is always a hard kill, and Ctrl+C reaches the bot from the console anyway → only wait there.
// A bot that hangs is killed after 15 s.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (process.platform !== 'win32') child?.kill(sig);
    setTimeout(() => child?.kill(), 15_000).unref();
  });
}

function run() {
  const lines = [];
  const startedAt = Date.now();
  child = spawn(process.execPath, ['--env-file=.env', 'src/main.js'], { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (buf) => {
      const text = redactSecrets(buf.toString());
      process.stdout.write(text);
      lines.push(...text.split(/\r?\n/).filter(Boolean));
      lines.splice(0, Math.max(0, lines.length - KEEP_LINES));
    });
  }
  child.on('exit', async (code, signal) => {
    child = null;
    if (stopping || code === 0) { console.log('[forever] бот остановлен.'); process.exit(0); }
    const log = new Error(lines.join('\n') || '(лог пуст)');
    if (code === EXIT_CONFIG) {
      await owner.alert('config', 'Бот ОСТАНОВЛЕН и сам не перезапустится', log,
        'ошибка настройки (.env, токен или вторая копия бота) — исправьте и запустите npm run forever снова');
      process.exit(EXIT_CONFIG);
    }
    crashes = Date.now() - startedAt > STABLE_MS ? 1 : crashes + 1;
    const wait = BACKOFF_S[Math.min(crashes - 1, BACKOFF_S.length - 1)];
    await owner.alert('crash', `Бот упал (код ${code ?? signal}) — перезапускаю через ${wait} с`, log, 'процесс бота на компьютере');
    setTimeout(run, wait * 1000);
  });
}

console.log('[forever] запускаю бота (Ctrl+C — остановить)…');
run();
