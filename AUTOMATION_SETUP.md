# Automation setup — agents, hooks, memory

Opportunities to make future sessions on LLM Board faster, cheaper, and less repetitive,
based on the friction that actually recurred while building EPIC #21. Ordered by payoff.
Each item is self-contained — do the ones you want, skip the rest.

---

## 1. (Highest value) A `verify` skill — kill the Playwright dance

**The problem it solves:** every tree slice repeated the same ritual — start uvicorn on
:8765, write a throwaway Playwright script in `/home/elizabet` (the only dir where the
`playwright` module resolves), intercept `/prompt` and POST `/board` so the live board
isn't touched, run it, read JSON, clean up. That's a lot of repeated tokens per slice.

**What to do:** create a project skill that encapsulates the harness, so I just write the
*assertions*, not the boilerplate.

Create `.claude/skills/verify-board/SKILL.md`:

```markdown
---
name: verify-board
description: Drive the LLM Board app headlessly to verify a change. Starts the
  backend on :8765, loads the _verify fixture with /prompt and POST /board
  intercepted (no live LLM call, fixture never mutated), runs an assertions
  snippet, prints JSON, and tears down. Use when verifying a frontend change.
---

To verify a change:

1. Start the server (from the repo root):
   `cd backend && (uvicorn main:app --port 8765 > /tmp/uvicorn_verify.log 2>&1 &)`
   then poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:8765/board/_verify`.

2. Run the harness from `/home/elizabet` (playwright resolves only there). Use the
   reusable harness at `frontend/test/verify-harness.mjs` (see item 2) — it sets up
   the page, the /prompt stub, the /board POST capture, and the default→_verify fetch
   rewrite. Pass it an async `(page, ctx) => {...}` that does the assertions and returns
   an object; it prints the object as JSON.

3. Tear down WITHOUT compound `&&` (pkill returns 144 and short-circuits chains):
   run `pgrep -f "port 8765"` then `kill -9 <pid>` as a separate call; remove temp scripts.

Acceptance pattern: assert layout/positions, fork/drag behaviour, and `errors.length === 0`
(collect `pageerror` + `console.error`). Always test at 100% AND a non-100% zoom for any
coordinate-sensitive change (the `/cam.k` math).
```

This turns "write 60 lines of harness" into "write 10 lines of assertions."

---

## 2. (Pairs with #1) Commit a reusable Playwright harness

Right now every verify script re-implements the same setup. Commit it once.

Create `frontend/test/verify-harness.mjs`:

```js
import { chromium } from 'playwright';

// runChecks: async (page, ctx) => object.  ctx = { lastSave: ()=>obj, stub }
export async function verify(runChecks, { board = '_verify', viewport = { width: 1600, height: 1000 } } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console:' + m.text()); });

  await page.route('**/prompt', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: 'stub answer.' }) }));
  let lastSave = null;
  await page.route('**/board/**', async (route) => {
    if (route.request().method() === 'POST') { lastSave = route.request().postDataJSON(); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    return route.continue();
  });
  await page.addInitScript((b) => {
    const o = window.fetch;
    window.fetch = (u, x) => { if (typeof u === 'string') u = u.replace('/board/default', '/board/' + b); return o(u, x); };
  }, board);

  await page.goto('http://localhost:8765/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const out = await runChecks(page, { lastSave: () => lastSave });
  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
```

Run a check from `/home/elizabet` with:
`node --input-type=module -e "import {verify} from '/home/elizabet/Code/experiments/LLM_Board/frontend/test/verify-harness.mjs'; verify(async (page) => { /* asserts */ return {...}; })"`
…or a tiny per-check `.mjs` that imports it. Either way the boilerplate lives in the repo, not in tokens.

---

## 3. (Quick win) Fix the permission allowlist

`.claude/settings.json` currently allows a `--host 127.0.0.1` form and `kill %1`, but this
session actually ran `uvicorn main:app --port 8765` (no host), `node`, `pgrep`, and
`kill -9 <pid>` — each prompting. Update the allow-list to match real usage.

Replace `.claude/settings.json` `permissions.allow` with:

```json
"allow": [
  "Bash(pip install *)",
  "Bash(uvicorn main:app --port 8765*)",
  "Bash(uvicorn main:app --reload --port 8000*)",
  "Bash(curl -s http://localhost:8765/*)",
  "Bash(curl -s -o /dev/null *)",
  "Bash(node --check *)",
  "Bash(node *.mjs)",
  "Bash(pgrep -f *)",
  "Bash(kill *)",
  "Bash(gh pr *)",
  "Bash(gh issue *)"
]
```

You can also just run `/fewer-permission-prompts` (a built-in skill) — it scans transcripts
and proposes an allowlist automatically. Either way, this removes most of the per-command
prompts that interrupted the flow.

---

## 4. (Optional hook) Enforce the no-Co-Author trailer

The repo convention is: commits never end with a `Co-Authored-By: Claude` trailer. Today
that's kept by memory + habit. A hook makes it impossible to get wrong.

Add to `.claude/settings.json`:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "if echo \"$CLAUDE_TOOL_INPUT\" | grep -qi 'co-authored-by: claude'; then echo 'Blocked: this repo forbids the Co-Authored-By: Claude trailer.' >&2; exit 2; fi"
        }
      ]
    }
  ]
}
```

(Exit code 2 blocks the call and feeds the message back to me. Verify the env-var name your
Claude Code version exposes for the tool input — it may be `$CLAUDE_TOOL_INPUT` or passed on
stdin as JSON; adjust the grep target accordingly. Test on a throwaway commit first.)

---

## 5. Memory — a couple of durable facts worth saving

The existing `no-coauthor-trailer.md` memory is good. Two more that would have saved
re-derivation this session (I can write these for you on request — say "save those memories"):

- **verify-harness** (reference): "Verify frontend changes by driving the app on :8765
  against the `_verify` fixture with `/prompt` and POST `/board` intercepted; the reusable
  harness is `frontend/test/verify-harness.mjs`. Playwright resolves only from
  `/home/elizabet`. Test coordinate-sensitive changes at 100% and a non-100% zoom."
- **pkill-144** (reference): "`pkill`/`kill` returning exit 144/1 short-circuits compound
  `&&` shell commands; stop the verify server in a standalone call, never chained."

I did NOT save these yet — they're only worth persisting if you want them across future
sessions. They're project-reference facts, not secrets.

---

## What I deliberately did NOT propose

- **A dedicated "tree-slice builder" agent** — the slice work is done; a bespoke agent for it
  would rarely fire. The general Explore/Plan agents already covered the heavy lifting.
- **A code-review hook on every commit** — `/code-review` per slice was the right cadence
  (you saw the findings before merge); auto-running it on every Bash-commit would add latency
  and noise to trivial commits.
- **Auto-compaction hooks** — compaction is a judgment call best left to you (`/compact` at
  merge points, per the feedback above), not automated.
