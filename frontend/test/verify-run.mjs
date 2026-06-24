import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { verify } from './verify-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '../../backend');
const READY_URL = 'http://localhost:8765/board/_verify';

async function isUp(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function waitForReady(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not become ready: ${url}`);
}

// Start uvicorn on :8765, wait until it answers, run the verify checks (which may take
// screenshots), then tear the server down — ALL in one process / one Bash call. The
// child stays alive because this node process does, so it can't be reaped between
// calls (the `(uvicorn &)`-subshell trap), and there's no manual kill/ps-confirm
// ritual. Only ever touches :8765 — never the user's :8000 --reload dev server.
export async function runWithServer(checks, opts = {}) {
  if (await isUp(READY_URL)) {
    throw new Error('a server is already on :8765 — kill it first (pgrep -f "port 8765" | xargs -r kill -9)');
  }
  const proc = spawn('uvicorn', ['main:app', '--port', '8765', '--app-dir', backend],
    { cwd: backend, stdio: 'ignore', detached: true });
  proc.on('error', (e) => { console.error(`failed to launch uvicorn: ${e.message}`); });

  let stopped = false;
  const stop = () => {
    if (stopped || !proc.pid) return;
    stopped = true;
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
  };
  process.on('exit', stop);

  try {
    await waitForReady(READY_URL);
    await verify(checks, opts);
  } finally {
    stop();
  }
}
