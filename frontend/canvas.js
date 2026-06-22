// The active board name. View-only state: persisted in localStorage (so a reload
// returns to the last forest), never in board JSON. Switching boards changes this.
let currentBoard = localStorage.getItem("llmboard.lastBoard") || "default";

let notes = [];
let saveTimer = null;

// Focus mode is view-only state — never persisted to `notes` / board JSON.
let focusMode = false;     // dim every group except the active one?
let activeGroupId = null;  // dataset id of the focused group (chain root id, or a text note id)

// Keyboard selection is view-only too — the id of the single "current" card the
// arrow keys walk and the number keys act on. Distinct from activeGroupId (which
// is a whole tree). Cleared on board switch/load and when its node is deleted.
let selectedId = null;

const canvas = document.getElementById("canvas");
const saveStatus = document.getElementById("save-status");

// ── Camera ────────────────────────────────────────────────────
// The canvas is a transform-driven "world" layer; `cam` is the view.
// Screen → world: worldX = (screenX - cam.x) / cam.k. World deltas under a
// scaled view are screenΔ / cam.k (used by drag/resize so they track the cursor).
// View-only — never persisted to board JSON.
const cam = { x: 0, y: 0, k: 1 };
const MIN_K = 0.2;
const MAX_K = 2.5;

// True when the OS requests reduced motion. Checked live (not cached) so toggling
// the system setting takes effect without a reload. Used to skip the tidy glide.
const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function applyCamera() {
  canvas.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  const label = document.getElementById("zoom-level");
  if (label) label.textContent = `${Math.round(cam.k * 100)}%`;
}

// Zoom keeping the screen point (px, py) — viewport-relative — fixed under the cursor.
function zoomAt(px, py, nextK) {
  nextK = Math.min(MAX_K, Math.max(MIN_K, nextK));
  const wx = (px - cam.x) / cam.k;
  const wy = (py - cam.y) / cam.k;
  cam.k = nextK;
  cam.x = px - wx * cam.k;
  cam.y = py - wy * cam.k;
  applyCamera();
}

function viewportCenter() {
  const r = document.getElementById("canvas-container").getBoundingClientRect();
  return { x: r.width / 2, y: r.height / 2 };
}

// Frame all content. Measures rendered element bounds in world space (their
// left/top/offset sizes are world units since the parent is the transform layer).
function fitAll() {
  // Measure only rendered note content (standalone notes + chain groups), not any
  // other layers that may live inside the world (e.g. a future SVG wires layer).
  let els = [...canvas.querySelectorAll(":scope > .note, :scope > [data-group-id]")];
  // In focus mode, frame just the active tree — fitting the whole forest would
  // zoom out past the dimmed groups the user is deliberately ignoring, so "fit"
  // and "focus" pulled against each other. Now fit honours the focus.
  if (focusMode && activeGroupId) {
    const inGroup = els.filter((el) => el.dataset.id && rootOf(el.dataset.id) === activeGroupId);
    if (inGroup.length) els = inGroup;
  }
  const r = document.getElementById("canvas-container").getBoundingClientRect();
  if (!els.length) {
    cam.x = 0; cam.y = 0; cam.k = 1;
    applyCamera();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  els.forEach((el) => {
    const x = el.offsetLeft, y = el.offsetTop;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + el.offsetWidth);
    maxY = Math.max(maxY, y + el.offsetHeight);
  });
  const pad = 80;
  const k = Math.min(
    MAX_K,
    Math.max(MIN_K, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)))
  );
  cam.k = k;
  cam.x = (r.width - (maxX + minX) * k) / 2;
  cam.y = (r.height - (maxY + minY) * k) / 2;
  applyCamera();
}

// Ease the camera so a node is comfortably in view, but only if it's currently
// off-screen (or near the edge) — so walking the tree with the arrows never loses
// the selected card, yet a node already in view doesn't twitch. Pans only (zoom
// unchanged); honours reduced-motion with an instant set.
function centerOnIfOffscreen(id) {
  const el = canvas.querySelector(`.note[data-id="${id}"]`);
  if (!el) return;
  const r = document.getElementById("canvas-container").getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const cx = el.offsetLeft + w / 2, cy = el.offsetTop + h / 2; // world centre
  // Node's bounding box in screen space.
  const sLeft = cam.x + el.offsetLeft * cam.k;
  const sTop = cam.y + el.offsetTop * cam.k;
  const sRight = sLeft + w * cam.k;
  const sBottom = sTop + h * cam.k;
  const margin = 60;
  const inView = sLeft >= margin && sTop >= margin &&
    sRight <= r.width - margin && sBottom <= r.height - margin;
  if (inView) return;
  const targetX = r.width / 2 - cx * cam.k;
  const targetY = r.height / 2 - cy * cam.k;
  if (prefersReducedMotion()) { cam.x = targetX; cam.y = targetY; applyCamera(); return; }
  const fromX = cam.x, fromY = cam.y, DUR = 320, t0 = performance.now();
  const ease = (p) => 1 - Math.pow(1 - p, 3); // easeOutCubic
  (function tick(now) {
    const p = Math.min(1, (now - t0) / DUR);
    cam.x = fromX + (targetX - fromX) * ease(p);
    cam.y = fromY + (targetY - fromY) * ease(p);
    applyCamera();
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

// ── Persistence ──────────────────────────────────────────────

// Board-level layout flag. A board without it is a pre-tree (vertical) board;
// since vertical chains are already linear trees, migration is just stamping
// the flag — the tidy-tree renderer lays the existing chains out horizontally
// with no structural change. Re-saved on next persist.
let layout = "tree";

async function loadBoard() {
  // Guard the whole load: an unreachable backend or a bad response otherwise
  // throws an uncaught rejection here, leaving a blank canvas with no feedback
  // (and, on boot, skipping the fitAll/refreshBoardList that follow this call).
  let data;
  try {
    const res = await fetch(`/board/${encodeURIComponent(currentBoard)}`);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    data = await res.json();
  } catch (err) {
    notes = [];
    pillPos = {};
    layout = "tree";
    renderAll();
    notify("Couldn't load board", `${err.message}. Is the backend running?`);
    return;
  }
  notes = data.notes || [];
  pillPos = data.pill_pos || {};
  const legacy = data.layout !== "tree" && notes.length > 0;
  layout = "tree";
  renderAll();
  // A pre-tree (vertical) board has stale x/y — run the one-time repack to lay it
  // out horizontally and store the positions, then it's stable like any tree
  // board. (Manual ✦ Tidy is the flowing-line layout; migration wants the full
  // clean repack so a vertical chain becomes a proper horizontal tree.)
  if (legacy) migrateLayout();
}

// POST the current notes to a given board. Extracted so both the debounced
// scheduleSave and the flush-before-switch path can reuse it.
async function saveBoard(name) {
  await fetch(`/board/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes, layout, pill_pos: pillPos }),
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus("saving");
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveBoard(currentBoard);
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus(""), 1500);
  }, 500);
}

// ── Themed modal (replaces native window.prompt / window.alert / confirm) ───
// askName resolves to the trimmed string (Enter / ok) or null (Esc / cancel).
// notify shows an info dialog with a single ok; resolves when dismissed.
// confirm shows ok + cancel; resolves true (ok) / false (cancel / Esc / backdrop).

const modalEls = {
  overlay: document.getElementById("modal-overlay"),
  title: document.getElementById("modal-title"),
  message: document.getElementById("modal-message"),
  input: document.getElementById("modal-input"),
  ok: document.getElementById("modal-ok"),
  cancel: document.getElementById("modal-cancel"),
};

function openModal({ title, message = "", initial, withInput, withCancel, okLabel }) {
  // withCancel defaults to withInput (a prompt always offers cancel); notify
  // passes neither (ok-only); confirm passes withCancel without withInput.
  const showCancel = withCancel ?? withInput;
  return new Promise((resolve) => {
    // Remember what had focus so we can restore it on close (WCAG 2.4.3) — a
    // keyboard user returns to where they were instead of being dumped at <body>.
    const trigger = document.activeElement;

    modalEls.title.textContent = title;
    modalEls.message.textContent = message;
    modalEls.ok.textContent = okLabel ?? "ok";
    modalEls.input.hidden = !withInput;
    modalEls.cancel.hidden = !showCancel;
    if (withInput) {
      modalEls.input.value = initial ?? "";
      // Give the text field an accessible name from the dialog title — a
      // placeholder alone isn't a label (WCAG 4.1.2 / 3.3.2).
      modalEls.input.setAttribute("aria-label", title);
    }
    modalEls.overlay.hidden = false;
    if (withInput) {
      modalEls.input.focus();
      modalEls.input.select();
    } else {
      modalEls.ok.focus();
    }

    // The focusable controls currently in the dialog, in tab order.
    const focusables = () =>
      [modalEls.input, modalEls.cancel, modalEls.ok].filter((el) => !el.hidden);

    function cleanup(result) {
      modalEls.overlay.hidden = true;
      modalEls.ok.removeEventListener("click", onOk);
      modalEls.cancel.removeEventListener("click", onCancel);
      modalEls.overlay.removeEventListener("mousedown", onBackdrop);
      modalEls.input.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("keydown", onTrap, true);
      // Restore focus to the trigger (if it's still in the DOM and focusable).
      if (trigger && typeof trigger.focus === "function" && document.contains(trigger)) {
        trigger.focus();
      }
      resolve(result);
    }
    const onOk = () => cleanup(withInput ? modalEls.input.value.trim() : true);
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => { if (e.target === modalEls.overlay) cleanup(null); };
    const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); onOk(); } };
    const onEsc = (e) => { if (e.key === "Escape") cleanup(null); };
    // Focus trap (WCAG 2.1.2): keep Tab/Shift+Tab cycling inside the dialog so
    // keyboard focus can't wander behind the overlay. Capture phase so it wins.
    const onTrap = (e) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !items.includes(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (active === last || !items.includes(active))) {
        e.preventDefault(); first.focus();
      }
    };

    modalEls.ok.addEventListener("click", onOk);
    modalEls.cancel.addEventListener("click", onCancel);
    modalEls.overlay.addEventListener("mousedown", onBackdrop);
    modalEls.input.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onEsc);
    document.addEventListener("keydown", onTrap, true);
  });
}

const askName = (title, initial) => openModal({ title, initial, withInput: true });
const notify = (title, message) => openModal({ title, message, withInput: false });
const confirm = (title, message, okLabel = "delete") =>
  openModal({ title, message, withInput: false, withCancel: true, okLabel }).then((r) => r === true);

// ── Multi-board switcher ──────────────────────────────────────

const boardSelect = document.getElementById("board-select");
const btnDeleteBoard = document.getElementById("menu-delete-board");

// Fetch the board list and rebuild the <select>, keeping currentBoard selected.
async function refreshBoardList() {
  // Degrade gracefully if the list can't be fetched: fall back to showing just
  // the current board rather than throwing (loadBoard already surfaces a
  // backend-down modal on boot; no need for a second one here).
  let boards = [];
  try {
    const res = await fetch("/boards");
    if (res.ok) ({ boards } = await res.json());
  } catch { /* keep the empty list; fallback below shows currentBoard */ }
  // currentBoard may be brand-new (not yet on disk) — include it so it shows.
  const names = boards.includes(currentBoard) ? boards : [...boards, currentBoard];
  // Build options via the DOM, not an innerHTML template — board names are
  // free user text (the backend only rejects path separators), so interpolating
  // them into HTML would be a stored-XSS hole. textContent escapes them.
  boardSelect.replaceChildren(
    ...names.map((n) => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      return opt;
    })
  );
  boardSelect.value = currentBoard;
  // The default board is the always-present home — never deletable.
  btnDeleteBoard.hidden = currentBoard === "default";
}

// Lowest free "New Board" / "New Board N" name given the existing names.
function nextBoardName(existing) {
  const base = "New Board";
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// Switch to an existing board. Flushes any pending save to the OLD board first
// (the debounced timer would otherwise drop the edit or save it to the new board),
// resets board-scoped view-only state, then loads + frames the target board.
async function switchBoard(name) {
  if (name === currentBoard) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveBoard(currentBoard);
    setSaveStatus("");
  }
  // Reset view-only state — never persisted, scoped to the board you were on.
  undoStack.length = 0;
  showUndo();
  focusMode = false;
  activeGroupId = null;
  selectedId = null;
  document.getElementById("btn-focus").classList.remove("active");

  currentBoard = name;
  localStorage.setItem("llmboard.lastBoard", currentBoard);
  await loadBoard();
  fitAll();
  await refreshBoardList();
}

// Create a fresh, empty board and switch to it. Prompts for a name, pre-filled
// with the auto-name ("New Board" / "New Board N"); blank or cancel keeps the
// auto-name. A name that's already taken falls back to the auto-name too.
async function newBoard() {
  const res = await fetch("/boards");
  const { boards } = await res.json();
  const auto = nextBoardName(boards);

  const entered = await askName("Name your new board", auto);
  if (entered === null) return;                 // cancelled → no board created
  let name = entered;                           // askName returns trimmed
  if (!name || boards.includes(name)) name = auto;

  // Flush a pending save to the CURRENT board first — otherwise the debounced
  // timer would fire after currentBoard changes and write to the new board.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveBoard(currentBoard);
  }
  // Reset view-only state, same as switchBoard.
  undoStack.length = 0;
  showUndo();
  focusMode = false;
  activeGroupId = null;
  selectedId = null;
  document.getElementById("btn-focus").classList.remove("active");

  notes = [];
  pillPos = {};
  currentBoard = name;
  localStorage.setItem("llmboard.lastBoard", currentBoard);
  renderAll();
  fitAll();
  scheduleSave();           // persist the empty board to disk
  await refreshBoardList();
}

// Rename the currently-selected board. Prompts for a new name, moves the board
// file on disk (POST /board/:name/rename), then points currentBoard at it.
async function renameBoard() {
  const entered = await askName("Rename this board", currentBoard);
  if (entered === null) return;
  const name = entered;                          // askName returns trimmed
  if (!name || name === currentBoard) return;

  // Flush any pending edit to the old name before the file moves underneath it.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveBoard(currentBoard);
  }
  const res = await fetch(`/board/${encodeURIComponent(currentBoard)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: name }),
  });
  if (!res.ok) {
    const { detail } = await res.json().catch(() => ({}));
    await notify("Couldn't rename", String(detail || res.status));
    return;
  }
  currentBoard = name;
  localStorage.setItem("llmboard.lastBoard", currentBoard);
  await refreshBoardList();
}

// Delete the currently-selected board (DELETE /board/:name) after a confirm,
// then fall back to the default board. The default board is protected and
// cannot be deleted (the control is hidden when it's active; the server also
// rejects it).
async function deleteBoard() {
  if (currentBoard === "default") return;
  const target = currentBoard;
  const ok = await confirm(
    "Delete this board?",
    `“${target}” and everything on it will be permanently removed. This can’t be undone.`
  );
  if (!ok) return;

  // Drop any pending save to the board we're deleting — don't resurrect it.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    setSaveStatus("");
  }
  const res = await fetch(`/board/${encodeURIComponent(target)}`, { method: "DELETE" });
  if (!res.ok) {
    const { detail } = await res.json().catch(() => ({}));
    await notify("Couldn't delete", String(detail || res.status));
    return;
  }
  // Reset board-scoped view state and fall back to default.
  undoStack.length = 0;
  showUndo();
  focusMode = false;
  activeGroupId = null;
  selectedId = null;
  document.getElementById("btn-focus").classList.remove("active");

  currentBoard = "default";
  localStorage.setItem("llmboard.lastBoard", currentBoard);
  await loadBoard();
  fitAll();
  await refreshBoardList();
}

function setSaveStatus(state) {
  saveStatus.className = state;
  saveStatus.textContent = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "";
}

// ── Undo affordance ───────────────────────────────────────────

const undoSlot = document.getElementById("undo-slot");

// Renders the undo affordance from the current stack depth. Visible while the
// stack is non-empty; no timeout — undo stays available until the stack drains
// (or the page reloads).
function showUndo() {
  const depth = undoStack.length;
  if (depth === 0) {
    undoSlot.classList.remove("visible");
    undoSlot.innerHTML = "";
    return;
  }
  const label = depth > 1 ? `${depth} undos` : "Deleted";
  undoSlot.innerHTML = `<span class="undo-label">${label}</span><button class="btn-undo">↶ undo</button>`;
  undoSlot.classList.add("visible");
  undoSlot.querySelector(".btn-undo").addEventListener("click", undoDelete);
}

// ── Note management ──────────────────────────────────────────

function generateId() {
  return crypto.randomUUID();
}

function addNote(type, extra = {}) {
  const note = {
    id: generateId(),
    type,
    x: null,
    y: null,
    content: "",
    prompt_template: "explain_term",
    parent_id: null,
    thread_id: null,
    conversation_context: null,
    conversation: null,
    ...extra,
  };
  notes.push(note);
  // One-time placement: a sensible non-overlapping spot, computed now and stored.
  // Existing nodes are never moved to make room. A brand-new root with no parent
  // and no given position lands near the viewport (inverse camera transform).
  if (note.x == null || note.y == null) {
    if (!note.parent_id) {
      const r = document.getElementById("canvas-container").getBoundingClientRect();
      const ys = notes.filter((n) => n.id !== note.id && n.y != null).map((n) => n.y);
      note.x = (r.width * 0.18 - cam.x) / cam.k;
      note.y = ys.length ? Math.max(...ys) + 220 : (r.height * 0.18 - cam.y) / cam.k;
    } else {
      placeNewNode(note);
    }
  }
  scheduleSave();
  return note;
}

// Each entry is one deletion's full subtree (root + descendants). Newest last;
// undo pops the most recent. Capped at UNDO_LIMIT — oldest dropped past the cap.
const undoStack = [];
const UNDO_LIMIT = 10;

function deleteNote(id) {
  // If this is a forked response (its parent is a hidden follow-up prompt),
  // delete the whole fork unit from that prompt — otherwise the hidden prompt
  // would be left orphaned. The move pill un-spends naturally on re-render.
  const target = notes.find((n) => n.id === id);
  if (target && target.parent_id) {
    const parent = notes.find((n) => n.id === target.parent_id);
    if (parent && isHiddenPrompt(parent)) id = parent.id;
  }

  // Collect the whole subtree (root + descendants) before mutating `notes`,
  // so undo restores it as one unit rather than orphaned fragments.
  const removed = [];
  (function collect(targetId) {
    const note = notes.find((n) => n.id === targetId);
    if (!note) return;
    removed.push(note);
    notes.filter((n) => n.parent_id === targetId).forEach((c) => collect(c.id));
  })(id);
  if (!removed.length) return;

  const removedIds = new Set(removed.map((n) => n.id));
  notes = notes.filter((n) => !removedIds.has(n.id));
  if (removedIds.has(selectedId)) selectedId = null; // don't keep a dead selection

  // Drop any dragged-pill positions for the removed responses (else they leak).
  Object.keys(pillPos).forEach((k) => {
    if (removedIds.has(k.split(":")[0])) delete pillPos[k];
  });

  undoStack.push(removed);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  showUndo();

  renderAll();
  scheduleSave();
}

function undoDelete() {
  const removed = undoStack.pop();
  if (!removed) return;
  notes.push(...removed);
  showUndo();
  renderAll();
  scheduleSave();
}

function updateNote(id, fields) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  Object.assign(note, fields);
  scheduleSave();
}

// ── Conversation history ──────────────────────────────────────

function buildHistory(responseNoteId) {
  // Walk chain upward collecting messages, then reverse to oldest→newest
  const messages = [];
  let current = notes.find((n) => n.id === responseNoteId);

  while (current) {
    if (current.type === "response" && current.content) {
      messages.unshift({ role: "assistant", content: current.content });
    } else if (current.type === "prompt") {
      // Reconstruct what was actually sent. A follow-up created by an explore move
      // (parent is a response) used an EXPLORE_MOVES move; a root prompt used a TEMPLATE.
      const text = (current.content || "").trim();
      let built;
      if (current.parent_id) {
        // Free-text follow-up ("ask your own", or a legacy null-template reply):
        // the stored content is the literal question — replay it verbatim.
        if (current.prompt_template === "__ask__" || current.prompt_template === null) {
          built = text || undefined;
        } else {
          const move = EXPLORE_MOVES.find((m) => m.id === current.prompt_template);
          if (move) built = move.build(text);
        }
      }
      if (built === undefined && text) {
        const tpl = TEMPLATES.find((t) => t.id === (current.prompt_template || "explain_term")) || TEMPLATES[0];
        built = tpl.build(text);
      }
      if (built) messages.unshift({ role: "user", content: built });
    }
    current = current.parent_id ? notes.find((n) => n.id === current.parent_id) : null;
  }

  return messages;
}

// One-click explore: build the move's prompt, create a NEW follow-up branch under
// this response (free forking — many children allowed), and run it in one step.
function exploreFromResponse(responseNoteId, move, inputText) {
  const responseNote = notes.find((n) => n.id === responseNoteId);
  if (!responseNote || responseNote.loading) return;
  dismissOrbitCoach(); // they've done the thing — retire the tip for good

  const history = buildHistory(responseNoteId);
  const threadId = responseNote.thread_id || responseNote.parent_id;

  const followUp = addNote("prompt", {
    parent_id: responseNoteId,
    thread_id: threadId,
    conversation_context: history,
    prompt_template: move.id,
    content: inputText || "",
  });

  runPrompt(followUp.id, move.build(inputText || ""));
}

// ── Detach: break-out & unlink (one op, two entry points) ─────

// Promote a node + its whole subtree to a forest root. The subtree travels via
// existing parent_id links (children keep pointing at their parents); only this
// node is cut loose. With originId → a break-out (keeps a dashed origin link to
// the source). Without → an unlink (fully standalone; context-before dropped).
function detachToRoot(nodeId, { originId } = {}) {
  const node = notes.find((n) => n.id === nodeId);
  if (!node) return;
  node.parent_id = null;
  node.is_root = true;
  if (originId) {
    node.origin_id = originId;
  } else {
    // Unlink: drop the context that came before, on this node AND its whole
    // subtree — descendants' stored context still referenced the pre-cut history,
    // which would otherwise replay if a descendant prompt were re-run.
    delete node.origin_id;
    const seen = new Set();
    (function clear(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const n = notes.find((x) => x.id === id);
      if (n) n.conversation_context = null;
      childrenOf(id).forEach((c) => clear(c.id));
    })(nodeId);
  }
  renderAll();
  scheduleSave();
}

// Break out a TERM from an answer into a fresh, standalone tree: a new prompt
// root (no carried context) that investigates the term on its own, with a faint
// dashed origin link back to the source response.
function breakOutTerm(sourceResponseId, term) {
  term = (term || "").trim();
  if (!term) return;
  const root = addNote("prompt", {
    content: term,
    prompt_template: "explain_term",
    is_root: true,
    origin_id: sourceResponseId,
  });
  const tpl = TEMPLATES.find((t) => t.id === "explain_term") || TEMPLATES[0];
  runPrompt(root.id, tpl.build(term));
}

// ── Prompt execution ─────────────────────────────────────────

async function runPrompt(parentId, builtPrompt) {
  const existing = notes.find((n) => n.parent_id === parentId && n.type === "response");
  if (existing) {
    notes = notes.filter((n) => n.id !== existing.id);
  }

  const parent = notes.find((n) => n.id === parentId);
  if (!parent) return;

  // Build messages: history context + new user message
  const messages = [
    ...(parent.conversation_context || []),
    { role: "user", content: builtPrompt },
  ];

  const responseNote = {
    id: generateId(),
    type: "response",
    x: null,
    y: null,
    content: "",
    parent_id: parentId,
    thread_id: parent.thread_id || parentId,
    conversation: null,
    loading: true,
  };
  notes.push(responseNote);
  placeNewNode(responseNote); // one-time spot (right of its source; nothing else moves)
  renderAll();

  try {
    const res = await fetch("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Unknown error");
    responseNote.content = data.response;
    responseNote.conversation = [...messages, { role: "assistant", content: data.response }];
  } catch (err) {
    responseNote.content = `Error: ${err.message}`;
  } finally {
    responseNote.loading = false;
    renderAll();
    scheduleSave();
  }
}

// ── Rendering ─────────────────────────────────────────────────

// Tidy-tree layout constants (world px).
const COL_W = 560;     // horizontal distance between depth columns (room for the orbit gutter:
                       // ~290 card + 90 gap + 132 pill, so pills never reach the child column)
const ROW_GAP = 28;    // vertical gap between sibling subtrees
const TREE_GAP = 70;   // vertical gap between top-level trees
const FALLBACK_H = 150; // assumed card height before it has been measured

// "Flowing line" tidy params (the manual ✦ Tidy). A branch is laid out as a
// gently bending train-of-thought rather than a rigid column grid. The meander
// is a pure function of DEPTH, so all nodes at one depth shift identically —
// which keeps sibling/cousin gaps intact (overlap-safe) while a chain reads as a
// soft sine wave. The fan nudges forked children a touch further right the more
// they sit off their parent's centre-line, so a fork peels open instead of
// stacking. Both are deliberately "subtle" (tunable here).
const FLOW_AMP = 14;        // px — meander amplitude along a chain
const FLOW_PHASE = 1.1;     // radians of meander per depth (wave frequency)
const FLOW_FAN = 22;        // px — max extra rightward nudge for an off-axis child
const FLOW_FAN_RATIO = 0.14;// how strongly vertical offset converts to fan nudge

// Orbit (floating explore-move pills shown right of each response).
const ORBIT_GAP = 90;  // gap between a response's right edge and its orbit pills
                       // (roomy, so the connecting tethers are clearly visible)
const ORBIT_W = 132;   // orbit pill width
const MOVE_H = 27;      // orbit pill height
const ORBIT_VGAP = 6;  // vertical gap between orbit pills

// Dragged pill positions, keyed `${responseId}:${moveId}` → {x, y} (absolute
// world coords). A pill with an entry here is freeform; others use the default
// orbit slot. Persisted on the board so a custom arrangement survives reload.
let pillPos = {};

// The pills shown on a response: every explore move + an "ask your own" entry.
// Shared by orbitHeightFor (layout reservation) and the renderer so they agree.
function orbitMovesFor(note) {
  const content = (note.content || "").trim();
  // Eligible: a response that has a real answer (not loading, not an error).
  if (note.type !== "response" || note.loading || !content || content.startsWith("Error:")) return [];
  return [
    ...EXPLORE_MOVES,
    { id: "__newtree__", label: "↗ new tree", needsInput: true, inputPlaceholder: "which term?", breakout: true },
    // "Ask your own" is a free-text follow-up: it reveals an input like the other
    // needsInput pills, and its build() is the identity — the typed text IS the
    // question sent (buildHistory special-cases "__ask__" to replay it verbatim).
    { id: "__ask__", label: "↩ ask your own", ask: true, needsInput: true, inputPlaceholder: "your question…", build: (i) => i },
  ];
}
// Vertical space the orbit cluster needs, so a response reserves room for its pills.
function orbitHeightFor(note) {
  const m = orbitMovesFor(note).length;
  return m ? m * MOVE_H + (m - 1) * ORBIT_VGAP : 0;
}

// A forest root is any note with no parent (a chain-root prompt, a standalone
// text note, or a detached/broken-out node — which also has parent_id null). Each
// lays out as its own tree in its own vertical band. Keying strictly on parent_id
// avoids double-rendering if a node were ever marked is_root with a live parent.
function forestRoots() {
  return notes.filter((n) => !n.parent_id);
}
function childrenOf(id) {
  return notes.filter((n) => n.parent_id === id);
}

// A follow-up prompt (a prompt with a parent — created by an explore move or
// "ask your own") is NOT shown as a card: the move pill IS the question, so its
// answer connects directly. Only the ROOT prompt of a tree is a visible prompt.
function isHiddenPrompt(note) {
  return note.type === "prompt" && !!note.parent_id;
}
// Visible children for layout/wires: a hidden follow-up prompt is a pass-through,
// so we surface ITS children (the forked responses) in its place. Returns
// {node, viaPrompt} — viaPrompt is the hidden prompt a response came through (if
// any), used to route the wire from the source response's move pill.
function displayChildrenOf(id) {
  const out = [];
  childrenOf(id).forEach((c) => {
    if (isHiddenPrompt(c)) {
      childrenOf(c.id).forEach((gc) => out.push({ node: gc, viaPrompt: c }));
    } else {
      out.push({ node: c, viaPrompt: null });
    }
  });
  return out;
}

// Walk up parent links to the forest root that owns this node. `guard` caps the
// walk so a malformed parent_id cycle can't loop forever.
function rootOf(id) {
  let cur = notes.find((n) => n.id === id);
  let guard = 0;
  while (cur && cur.parent_id && guard++ < 10000) {
    cur = notes.find((n) => n.id === cur.parent_id);
  }
  return cur ? cur.id : id;
}

// ── Keyboard selection & tree navigation ─────────────────────
// Selection is view-only (selectedId). selectNote repaints so the .selected ring
// shows, eases the card into view if it's off-screen, and (first time only) pops
// the keyboard coach so the moves teach themselves.
function selectNote(id, { pan = true } = {}) {
  selectedId = id;
  renderAll();
  if (pan && id) centerOnIfOffscreen(id);
  maybeShowKeysCoach();
}

// The visible parent of a node, skipping the hidden follow-up prompt that sits
// between a source response and its forked response (response → hidden prompt →
// response). Returns null for a forest root.
function visibleParentOf(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return null;
  if (note.parent_id) {
    const parent = notes.find((n) => n.id === note.parent_id);
    if (parent && isHiddenPrompt(parent)) return parent.parent_id || null;
    return note.parent_id;
  }
  // A break-out root has no parent_id but keeps origin_id (the answer it came
  // from, shown as a dashed link). For navigation we treat that origin as its
  // parent, so a break-out reads as a sibling of the origin's forks and ← jumps
  // back to it. Only when the origin still exists; otherwise it's a plain root.
  if (note.origin_id && notes.some((n) => n.id === note.origin_id)) return note.origin_id;
  return null;
}

// Navigable children of a node: its visible forked responses PLUS any break-out
// trees that originated from it (origin_id), so → can reach them and they share
// the forks' sibling list.
function navChildrenOf(id) {
  const kids = displayChildrenOf(id).map((c) => c.node);
  const breakouts = notes.filter((n) => !n.parent_id && n.origin_id === id);
  return kids.concat(breakouts);
}

// Top-level roots for the ↑/↓ sibling list: forest roots that have no live
// navigation-parent (so break-outs, which now live under their origin, don't
// clutter the base-root list — unless their origin was deleted).
function topLevelRoots() {
  return forestRoots().filter((n) => !visibleParentOf(n.id));
}

// A node's visible siblings (including itself), ordered top-to-bottom by stored y
// so ↑/↓ match what's on screen.
function siblingsOf(id) {
  const vp = visibleParentOf(id);
  const list = vp ? navChildrenOf(vp) : topLevelRoots();
  return list.slice().sort((a, b) => (a.y || 0) - (b.y || 0));
}

// Move selection along the tree. dir: "right" (first child), "left" (parent),
// "up"/"down" (previous/next sibling). No-op when there's no node that way.
function navigate(dir) {
  if (!selectedId) {
    const roots = topLevelRoots().slice().sort((a, b) => (a.y || 0) - (b.y || 0));
    if (roots.length) selectNote(roots[0].id);
    return;
  }
  if (dir === "right") {
    const kids = navChildrenOf(selectedId);
    if (kids.length) selectNote(kids.slice().sort((a, b) => (a.y || 0) - (b.y || 0))[0].id);
  } else if (dir === "left") {
    const vp = visibleParentOf(selectedId);
    if (vp) selectNote(vp);
  } else if (dir === "up" || dir === "down") {
    const sibs = siblingsOf(selectedId);
    const i = sibs.findIndex((n) => n.id === selectedId);
    if (i === -1) return;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < sibs.length) selectNote(sibs[j].id);
  }
}

// The forked response a given one-shot move already produced on a response, if
// any: response → hidden prompt (prompt_template === moveId) → forked response.
function existingChildViaMove(responseId, moveId) {
  const hidden = notes.find(
    (n) => n.parent_id === responseId && isHiddenPrompt(n) && n.prompt_template === moveId
  );
  if (!hidden) return null;
  const kid = notes.find((n) => n.parent_id === hidden.id);
  return kid ? kid.id : null;
}

// Number key on the selected response: fire its d-th orbit move (1-based). For a
// one-shot move (no input) that has ALREADY been used, jump to the existing
// answer instead of forking a duplicate — pressing the number reads as "go to
// that branch". (needsInput moves still reveal their field, since each use is a
// distinct question; and the mouse keeps its deliberate re-fork on a spent pill.)
function fireOrbitByNumber(d) {
  if (!selectedId) return;
  const note = notes.find((n) => n.id === selectedId);
  if (!note) return;
  const move = orbitMovesFor(note)[d - 1];
  if (!move) return;
  if (!move.needsInput) {
    const existing = existingChildViaMove(note.id, move.id);
    if (existing) { selectNote(existing); return; }
  }
  const layer = document.getElementById("orbits");
  const pill = layer && layer.querySelector(`.orbit-move[data-resp="${selectedId}"][data-pill-index="${d}"]`);
  const label = pill && pill.querySelector(".orbit-label");
  if (label) label.click();
}

// Height a node's subtree occupies: max(own card height, total height of its
// children's subtrees + gaps). Uses measured heights from `heights`. `seen`
// guards against a parent_id cycle.
function subtreeHeight(note, heights, seen = new Set()) {
  if (seen.has(note.id)) return 0;
  seen.add(note.id);
  const own = heights[note.id] || FALLBACK_H;
  const orbit = orbitHeightFor(note); // 0 unless this is a response showing pills
  const kids = displayChildrenOf(note.id); // hidden follow-up prompts are passed through
  if (!kids.length) return Math.max(own, orbit);
  const kidsTotal = kids.reduce((sum, k) => sum + subtreeHeight(k.node, heights, seen), 0)
    + ROW_GAP * (kids.length - 1);
  return Math.max(own, kidsTotal, orbit);
}

// Assign world x/y to every visible node in a subtree: x by depth column, y
// centered on the node's subtree band so siblings never overlap. Used only by the
// on-demand tidy (computeForest) — it produces clean positions, ignoring any
// freeform placement (tidy is the deliberate "re-align everything" action).
//   x: this node's left; top: top of the vertical band the subtree occupies.
function assignLayout(note, x, top, pos, heights, seen = new Set()) {
  if (seen.has(note.id)) return 0;
  seen.add(note.id);
  const band = subtreeHeight(note, heights);
  const ny = top + band / 2;
  pos[note.id] = { x, y: ny };
  const kids = displayChildrenOf(note.id);
  const childTotal = kids.reduce((s, k) => s + subtreeHeight(k.node, heights), 0)
    + ROW_GAP * Math.max(0, kids.length - 1);
  let cursor = ny - childTotal / 2;
  kids.forEach((k) => {
    const kBand = subtreeHeight(k.node, heights);
    assignLayout(k.node, x + COL_W, cursor, pos, heights, seen);
    cursor += kBand + ROW_GAP;
  });
  return band;
}

// Lay out the whole forest given measured card heights, writing pos[id]={x,y}.
// Full repack: roots stacked top-to-bottom from y=0. Used ONLY for the one-time
// legacy (vertical→horizontal) migration now; the manual tidy uses flowForest.
function computeForest(heights) {
  const pos = {};
  let top = 0;
  forestRoots().forEach((root) => {
    top += assignLayout(root, 0, top, pos, heights) + TREE_GAP;
  });
  return pos;
}

// ── Flowing-line layout (the manual ✦ Tidy) ───────────────────
// Like assignLayout (same band allocation → no overlap, depth = order) but with
// the "train line" flow: a per-depth meander curves the line, and a fan nudges
// forked children rightward as they peel off their parent's centre-line. Writes
// pos[id] = { x: left, y: center }. `parentCY` is the parent's centre (null at
// the root) and `depth` drives the meander phase.
function assignFlow(note, x, top, pos, heights, depth, parentCY, seen = new Set()) {
  if (seen.has(note.id)) return 0;
  seen.add(note.id);
  const band = subtreeHeight(note, heights);
  const baseCY = top + band / 2;                 // un-meandered centre (drives child bands)
  const cy = baseCY + Math.sin(depth * FLOW_PHASE) * FLOW_AMP; // meander: same for every node at this depth
  const fan = parentCY == null ? 0 : Math.min(FLOW_FAN, Math.abs(cy - parentCY) * FLOW_FAN_RATIO);
  pos[note.id] = { x: x + fan, y: cy };
  const kids = displayChildrenOf(note.id);
  const childTotal = kids.reduce((s, k) => s + subtreeHeight(k.node, heights), 0)
    + ROW_GAP * Math.max(0, kids.length - 1);
  let cursor = baseCY - childTotal / 2;          // centre children on the un-meandered base
  kids.forEach((k) => {
    const kBand = subtreeHeight(k.node, heights);
    assignFlow(k.node, x + COL_W, cursor, pos, heights, depth + 1, cy, seen);
    cursor += kBand + ROW_GAP;
  });
  return band;
}

// Bounding box of one branch (its node ids), including the orbit gutter of any
// response showing pills, so branches don't get pushed into each other's pills.
function branchBox(ids, pos, sizes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ids.forEach((id) => {
    const p = pos[id];
    if (!p) return;
    const s = sizes[id] || { w: 290, h: FALLBACK_H };
    const note = notes.find((n) => n.id === id);
    const gutter = note && orbitMovesFor(note).length ? ORBIT_GAP + ORBIT_W : 0;
    const h = note ? Math.max(s.h, orbitHeightFor(note)) : s.h;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + s.w + gutter);
    minY = Math.min(minY, p.y - h / 2);
    maxY = Math.max(maxY, p.y + h / 2);
  });
  return { minX, minY, maxX, maxY };
}

// Lay out every branch as a flowing line in a local frame, ANCHOR each branch so
// its root keeps its current spot, then push whole branches apart as rigid units
// until none overlap. Returns pos[id] = { x: left, y: center }.
function flowForest(heights, sizes) {
  const pos = {};
  const branches = forestRoots().map((root) => {
    const local = {};
    const band = subtreeHeight(root, heights);
    assignFlow(root, 0, -band / 2, local, heights, 0, null); // root → local centre (0,0)
    // Anchor: translate so the root's stored top-left stays put.
    const rootH = heights[root.id] || FALLBACK_H;
    const dx = (root.x || 0) - local[root.id].x;
    const dy = ((root.y || 0) + rootH / 2) - local[root.id].y;
    const ids = Object.keys(local);
    ids.forEach((id) => { pos[id] = { x: local[id].x + dx, y: local[id].y + dy }; });
    return { ids };
  });

  // De-overlap branches as units: minimal nudges, whole branch moves together,
  // so each stays one cohesive cluster near where its root already was.
  const PAD = TREE_GAP;
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        const A = branchBox(branches[i].ids, pos, sizes);
        const B = branchBox(branches[j].ids, pos, sizes);
        const ox = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX) + PAD;
        const oy = Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY) + PAD;
        if (ox > 0 && oy > 0) {
          moved = true;
          const translate = (br, ddx, ddy) => br.ids.forEach((id) => { pos[id].x += ddx; pos[id].y += ddy; });
          if (oy <= ox) { // separate vertically (least penetration)
            const push = oy / 2;
            const aUp = (A.minY + A.maxY) <= (B.minY + B.maxY);
            translate(branches[i], 0, aUp ? -push : push);
            translate(branches[j], 0, aUp ? push : -push);
          } else {
            const push = ox / 2;
            const aLeft = (A.minX + A.maxX) <= (B.minX + B.maxX);
            translate(branches[i], aLeft ? -push : push, 0);
            translate(branches[j], aLeft ? push : -push, 0);
          }
        }
      }
    }
    if (!moved) break;
  }
  return pos;
}

// One-time legacy migration: a pre-tree (vertical) board has stale coords. Run
// the full repack (computeForest) ONCE to convert it to the horizontal model,
// then it's stable. Instant — it's a conversion, not a user gesture. (The manual
// ✦ Tidy is the flowing-line layout, anchored in place.)
function migrateLayout() {
  const heights = {};
  document.querySelectorAll("#canvas > .note").forEach((el) => { heights[el.dataset.id] = el.offsetHeight; });
  const pos = computeForest(heights);
  notes.forEach((note) => {
    const p = pos[note.id];
    if (!p) return;
    const h = heights[note.id] || FALLBACK_H;
    note.x = p.x;
    note.y = p.y - h / 2;
  });
  renderAll();
  scheduleSave();
}

// renderAll PAINTS the board from each note's STORED position (note.x/note.y) —
// it does not run the tidy-tree layout. Positions only change when a node is
// created (placeNewNode), dragged, or the user presses "tidy" (tidyTree). This
// is what keeps the canvas calm: touching one node never reflows the rest.
function renderAll() {
  canvas.innerHTML = "";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "wires";
  canvas.appendChild(svg);
  const orbitLayer = document.createElement("div");
  orbitLayer.id = "orbits";
  canvas.appendChild(orbitLayer);

  // pos[id] = the node's stored top-left {x,y}. (Wires use vertical centers,
  // computed once cards are measured below.)
  const pos = {};
  const cards = {};
  notes.forEach((note) => {
    if (isHiddenPrompt(note)) return; // follow-up prompts render no card (pass-through)
    const el = createNoteElement(
      note, deleteNote, runPrompt, updateNote, null, exploreFromResponse
    );
    el.style.position = "absolute";
    el.style.left = `${note.x || 0}px`;
    el.style.top = `${note.y || 0}px`;
    el.dataset.id = note.id;
    attachResize(el, note);
    attachNodeDrag(el, note);        // free per-node drag + long-press unlink
    if (note.type === "response") attachSelectionBreakout(el, note);
    if (note.id === selectedId) el.classList.add("selected");
    const rootId = rootOf(note.id);
    applyFocus(el, rootId);
    attachFocusClick(el, rootId);
    attachSelectClick(el, note.id);
    canvas.appendChild(el);
    cards[note.id] = el;
    pos[note.id] = { x: note.x || 0, y: (note.y || 0) + el.offsetHeight / 2 };
  });

  const orbitPos = buildOrbits(orbitLayer, pos, cards);
  drawWires(svg, pos, cards, orbitPos);

  lastRender = { svg, pos, cards, orbitPos };
  syncEmptyState();
  maybeShowOrbitCoach(orbitPos);
}

// Show the welcome card only on a truly empty board; hide it the moment any note
// exists. View-only — never persisted. Routed through renderAll so every state
// change (add/delete/undo/switch board) keeps it in sync automatically.
const emptyState = document.getElementById("empty-state");
function syncEmptyState() {
  if (emptyState) emptyState.hidden = notes.length > 0;
}

// First-run coach-mark for the orbit pills (the headline fork-the-thread move).
// Shown ONCE per browser, the first time any response renders its explore pills.
// The "seen" flag lives in localStorage (view-only, like lastBoard) — never in a
// board's JSON. Dismissed by the button, by Esc, or by firing any move.
const coachOrbit = document.getElementById("coach-orbit");
const COACH_KEY = "llmboard.coach.orbitSeen";
function maybeShowOrbitCoach(orbitPos) {
  if (!coachOrbit) return;
  if (localStorage.getItem(COACH_KEY)) return;            // already seen
  const hasPills = orbitPos && Object.keys(orbitPos).length > 0;
  if (hasPills) coachOrbit.hidden = false;
}
function dismissOrbitCoach() {
  if (!coachOrbit || coachOrbit.hidden) return;
  coachOrbit.hidden = true;
  localStorage.setItem(COACH_KEY, "1");
}
if (coachOrbit) {
  document.getElementById("coach-dismiss").addEventListener("click", dismissOrbitCoach);
  // Esc dismisses; so does actually firing a move (handled in exploreFromResponse),
  // so the tip never lingers once the user has done the thing.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !coachOrbit.hidden) dismissOrbitCoach();
  });
}

// Keyboard cheat-sheet (#coach-keys): shown ONCE the first time a card is selected
// (self-teaching the arrow/number bindings), then rediscoverable any time via ?.
// The "seen" flag is view-only localStorage, never a board's JSON — same contract
// as the orbit coach above.
const coachKeys = document.getElementById("coach-keys");
const KEYS_COACH_KEY = "llmboard.coach.keysSeen";
function maybeShowKeysCoach() {
  if (!coachKeys) return;
  if (localStorage.getItem(KEYS_COACH_KEY)) return; // already seen
  coachKeys.hidden = false;
}
function dismissKeysCoach() {
  if (!coachKeys || coachKeys.hidden) return;
  coachKeys.hidden = true;
  localStorage.setItem(KEYS_COACH_KEY, "1");
}
// ? re-opens (or closes) the panel even after it's been dismissed, so the legend
// is never lost. Opening this way also marks it seen.
function toggleKeysCoach() {
  if (!coachKeys) return;
  if (coachKeys.hidden) { coachKeys.hidden = false; localStorage.setItem(KEYS_COACH_KEY, "1"); }
  else coachKeys.hidden = true;
}
if (coachKeys) {
  const d = document.getElementById("coach-keys-dismiss");
  if (d) d.addEventListener("click", dismissKeysCoach);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !coachKeys.hidden) dismissKeysCoach();
  });
}

// Latest render state, used by redrawWiresLive during a drag.
let lastRender = null;

// Redraw wires (and pill tethers) against a dragged element's CURRENT on-screen
// position, so connectors track live. `kind` is "node" or "pill".
function redrawWiresLive(id, kind, pillKey) {
  if (!lastRender) return;
  const { svg, pos, cards, orbitPos } = lastRender;
  if (kind === "node") {
    const el = cards[id];
    if (el) pos[id] = { x: el.offsetLeft, y: el.offsetTop + el.offsetHeight / 2 };
  }
  svg.innerHTML = "";
  drawWires(svg, pos, cards, orbitPos);
}

// ── On-demand layout: place-once + tidy ───────────────────────

// Compute a non-overlapping spot for ONE freshly-created node and store it on the
// note. Existing nodes are never moved. A root goes into clear space below all
// current content; a fork goes right of its source response, stacked below any
// siblings already placed there.
function placeNewNode(note) {
  if (isHiddenPrompt(note)) return; // hidden — never placed/painted
  // Find the source response this node hangs off (direct parent, or the parent of
  // its hidden follow-up prompt).
  let source = null;
  if (note.parent_id) {
    const parent = notes.find((n) => n.id === note.parent_id);
    source = parent && isHiddenPrompt(parent) ? notes.find((n) => n.id === parent.parent_id) : parent;
  }
  if (source && source.x != null) {
    // Right of the source, stacked below siblings already sharing that column.
    const colX = source.x + COL_W;
    const siblings = displayChildrenOf(source.id)
      .map((c) => c.node).filter((n) => n.id !== note.id && n.y != null);
    const below = siblings.length ? Math.max(...siblings.map((s) => s.y)) + 200 : (source.y || 0);
    note.x = colX;
    note.y = below;
  } else {
    // A root with no placement yet: drop it in clear space below everything.
    const ys = notes.filter((n) => n.id !== note.id && n.y != null).map((n) => n.y);
    note.x = 40;
    note.y = ys.length ? Math.max(...ys) + 220 : 40;
  }
}

// The user-invoked tidy: lay every branch out as a flowing line, anchored to
// where its root already sits, and GLIDE the cards into place — the only time
// the canvas moves on its own. It animates the live DOM (rather than
// re-rendering) so cards transition from their current spots; wires are redrawn
// each frame during the glide. Pills snap back to their default orbit. Soft,
// slow easing ("leaves settling"), never an abrupt snap.
function tidyTree() {
  const heights = {};
  const sizes = {};
  const measured = {};
  document.querySelectorAll("#canvas > .note").forEach((el) => {
    heights[el.dataset.id] = el.offsetHeight;
    sizes[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight };
    measured[el.dataset.id] = el;
  });
  const pos = flowForest(heights, sizes); // {id:{x:left, y:center}}, anchored + de-overlapped

  pillPos = {}; // pills return to their orbit

  // Reduced-motion: skip the glide entirely. Write final positions and settle in
  // one clean render — no 1.1s animation that could provoke discomfort.
  if (prefersReducedMotion()) {
    notes.forEach((note) => {
      const p = pos[note.id];
      if (!p) return;
      const el = measured[note.id];
      const h = el ? el.offsetHeight : FALLBACK_H;
      note.x = p.x;
      note.y = p.y - h / 2;
    });
    renderAll();
    scheduleSave();
    return;
  }

  document.body.classList.add("tidying");
  // Write new stored positions and nudge the live elements; CSS glides them.
  notes.forEach((note) => {
    const p = pos[note.id];
    if (!p) return;
    const el = measured[note.id];
    const h = el ? el.offsetHeight : FALLBACK_H;
    note.x = p.x;
    note.y = p.y - h / 2;
    if (el) { el.style.left = `${note.x}px`; el.style.top = `${note.y}px`; }
  });

  // Re-place orbit pills to match (they have no stored pin now) and keep wires
  // following the gliding cards for the duration of the transition.
  const DUR = 1150;
  let raf;
  const startTs = { v: null };
  const tick = (ts) => {
    if (startTs.v == null) startTs.v = ts;
    // Rebuild orbit layer + wires from current DOM card positions each frame.
    refreshOrbitsAndWiresFromDom();
    if (ts - startTs.v < DUR) raf = requestAnimationFrame(tick);
    else {
      document.body.classList.remove("tidying");
      renderAll(); // settle: clean rebuild at the final positions
      scheduleSave();
    }
  };
  raf = requestAnimationFrame(tick);
}

// Redraw wires from the cards' CURRENT on-screen positions (used during the tidy
// glide so connectors track the moving cards). Orbit pills are left to settle and
// are rebuilt once at the end by renderAll — cheaper than rebuilding them per frame.
function refreshOrbitsAndWiresFromDom() {
  if (!lastRender) return;
  const { svg, orbitPos } = lastRender;
  const cards = {};
  const pos = {};
  document.querySelectorAll("#canvas > .note").forEach((el) => {
    cards[el.dataset.id] = el;
    pos[el.dataset.id] = { x: el.offsetLeft, y: el.offsetTop + el.offsetHeight / 2 };
  });
  lastRender.pos = pos;
  lastRender.cards = cards;
  svg.innerHTML = "";
  drawWires(svg, pos, cards, orbitPos);
}

// Render the floating move pills for every eligible response. Returns
// orbitPos[responseId][moveId] = {x, y} of each pill (left-center), used by
// drawWires to route a forked child's wire through the move that spawned it.
function buildOrbits(layer, pos, cards) {
  const orbitPos = {};
  notes.forEach((note) => {
    const moves = orbitMovesFor(note);
    if (!moves.length) return;
    const p = pos[note.id];
    if (!p) return;
    const cardW = cards[note.id] ? cards[note.id].offsetWidth : 290;
    const defaultX = p.x + cardW + ORBIT_GAP;
    const blockH = moves.length * MOVE_H + (moves.length - 1) * ORBIT_VGAP;
    const firstTop = p.y - blockH / 2;
    const usedMoveIds = new Set(childrenOf(note.id).map((c) => c.prompt_template));
    const dimmed = focusMode && rootOf(note.id) !== activeGroupId;
    orbitPos[note.id] = {};

    moves.forEach((move, i) => {
      const key = `${note.id}:${move.id}`;
      // A dragged pill keeps its stored absolute position; others sit in the
      // default orbit slot to the right of the response.
      const pinned = pillPos[key];
      const left = pinned ? pinned.x : defaultX;
      const top = pinned ? pinned.y : firstTop + i * (MOVE_H + ORBIT_VGAP);
      orbitPos[note.id][move.id] = { x: left, y: top + MOVE_H / 2 };
      // While this response is the keyboard selection, each pill carries a 1-based
      // number so the number-key binding teaches itself (the badge is built inside
      // buildOrbitPill). The index is also how a number keypress finds its pill.
      const selected = note.id === selectedId;
      const pill = buildOrbitPill(note, move, usedMoveIds.has(move.id), dimmed, i + 1, selected);
      pill.style.left = `${left}px`;
      pill.style.top = `${top}px`;
      pill.dataset.resp = note.id;       // so a dragged response can carry its pills
      pill.dataset.move = move.id;
      pill.dataset.pillIndex = i + 1;    // 1-based; matched by the number-key handler
      attachPillDrag(pill, note.id, move.id);
      layer.appendChild(pill);
    });
  });
  return orbitPos;
}

// Pills are freely draggable; a dragged pill pins to absolute world coords
// (pillPos) and its tether follows live. A plain click still fires the move
// (drag is only entered past a small movement threshold).
function attachPillDrag(pill, responseId, moveId) {
  const label = pill.querySelector(".orbit-label");
  if (!label) return;
  label.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    const origX = parseFloat(pill.style.left) || 0;
    const origY = parseFloat(pill.style.top) || 0;
    let dragging = false, raf = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESH) { dragging = true; pill.style.zIndex = 1000; }
      if (dragging) {
        e.stopPropagation();
        const nx = origX + dx / cam.k, ny = origY + dy / cam.k;
        pill.style.left = `${nx}px`;
        pill.style.top = `${ny}px`;
        if (!raf) {
          raf = true;
          requestAnimationFrame(() => {
            raf = false;
            const o = lastRender && lastRender.orbitPos[responseId];
            if (o) o[moveId] = { x: nx, y: ny + MOVE_H / 2 };
            redrawWiresLive(responseId, "pill");
          });
        }
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      pill.style.zIndex = "";
      if (dragging) {
        pillPos[`${responseId}:${moveId}`] = { x: parseFloat(pill.style.left), y: parseFloat(pill.style.top) };
        // Suppress the trailing click so the move doesn't fire after a drag. The
        // pill click handlers (buildOrbitPill) bail while wasDragging is set; the
        // flag clears after the click event that follows this mouseup is dispatched.
        wasDragging = true; setTimeout(() => { wasDragging = false; }, 0);
        scheduleSave();
      }
    };
    // Capture phase so we can intercept before the label's own click handler.
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  });
}

// One orbit pill. Non-input moves fork on click; needsInput moves toggle a tiny
// inline input (Enter submits, Esc cancels); the ask pill opens the reply path.
function buildOrbitPill(note, move, spent, dimmed, index, selected) {
  const pill = document.createElement("div");
  pill.className = "orbit-move" + (move.ask ? " ask" : "") + (move.breakout ? " breakout" : "")
    + (spent ? " spent" : "") + (dimmed ? " dimmed" : "");

  const label = document.createElement("button");
  label.className = "orbit-label";
  // Number badge — only while the parent response is the keyboard selection, and
  // only for the first nine pills (the keys we bind). Self-teaches "press N".
  if (selected && index <= 9) {
    const num = document.createElement("span");
    num.className = "pill-num";
    num.textContent = index;
    num.setAttribute("aria-hidden", "true"); // decorative; the label carries meaning
    label.appendChild(num);
  }
  label.appendChild(document.createTextNode(move.label));
  pill.appendChild(label);

  if (!move.needsInput) {
    label.addEventListener("click", (e) => { e.stopPropagation(); if (wasDragging) return; exploreFromResponse(note.id, move, ""); });
    return pill;
  }

  // needsInput: reveal an inline field on click.
  const field = document.createElement("input");
  field.type = "text";
  field.className = "orbit-input";
  field.placeholder = move.inputPlaceholder || "…";
  pill.appendChild(field);
  label.addEventListener("click", (e) => {
    e.stopPropagation();
    if (wasDragging) return;
    pill.classList.toggle("open");
    if (pill.classList.contains("open")) field.focus();
  });
  field.addEventListener("click", (e) => e.stopPropagation());
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && field.value.trim()) {
      if (move.breakout) breakOutTerm(note.id, field.value.trim());
      else exploreFromResponse(note.id, move, field.value.trim());
    } else if (e.key === "Escape") {
      pill.classList.remove("open");
    }
  });
  return pill;
}

// Draw parent→child wires. A forked child routes through the spent orbit pill
// of the move that spawned it (strong); other children anchor at the parent's
// right edge. Also draws thin response→orbit tethers for every pill.
function drawWires(svg, pos, cards, orbitPos) {
  const wire = (ax, ay, zx, zy, cls) => {
    const dx = Math.max(30, (zx - ax) / 2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${ax} ${ay} C ${ax + dx} ${ay}, ${zx - dx} ${zy}, ${zx} ${zy}`);
    path.setAttribute("class", cls);
    svg.appendChild(path);
  };

  notes.forEach((note) => {
    if (isHiddenPrompt(note)) return; // hidden prompts draw no wires of their own
    const cp = pos[note.id];
    if (!cp) return;
    const pw = cards[note.id] ? cards[note.id].offsetWidth : 290;
    const myOrbits = orbitPos[note.id];

    // Thin tethers: response right edge → each of its orbit pills.
    if (myOrbits) {
      Object.values(myOrbits).forEach((o) => wire(cp.x + pw, cp.y, o.x, o.y, "wire-orbit"));
    }

    // Visible children: a forked response reached through a hidden prompt routes
    // from the move pill that spawned it (strong); direct children (root→response)
    // anchor at this card's right edge.
    displayChildrenOf(note.id).forEach(({ node: child, viaPrompt }) => {
      const kp = pos[child.id];
      if (!kp) return;
      const moveId = viaPrompt && viaPrompt.prompt_template;
      const via = moveId && myOrbits && myOrbits[moveId];
      const ax = via ? via.x + ORBIT_W : cp.x + pw;
      const ay = via ? via.y : cp.y;
      wire(ax, ay, kp.x, kp.y, "wire");
    });
  });

  // Faint dashed origin links: source response → a broken-out root.
  notes.forEach((note) => {
    if (!note.origin_id) return;
    const src = pos[note.origin_id], dst = pos[note.id];
    if (!src || !dst) return;
    const sw = cards[note.origin_id] ? cards[note.origin_id].offsetWidth : 290;
    wire(src.x + sw, src.y, dst.x, dst.y, "wire-origin");
  });
}

// In focus mode, dim every top-level group whose id isn't the active one.
// Derived/visual only — applied during renderAll, never persisted.
function applyFocus(el, groupId) {
  if (focusMode && groupId !== activeGroupId) el.classList.add("dimmed");
}

// The first forest root in render order. Used to pre-select a group when focus
// mode turns on so the view is never "everything dimmed, nothing bright".
// Keyed the same way as the per-card focus group (rootOf). null on an empty board.
function firstGroupId() {
  const roots = forestRoots();
  return roots.length ? roots[0].id : null;
}

// Click a group (while focus mode is on) to make it the active, bright one.
// Ignores drag-releases and clicks on controls/inputs so normal use is intact.
function attachFocusClick(el, groupId) {
  el.addEventListener("click", (e) => {
    if (!focusMode || wasDragging) return;
    if (e.target.closest("button, textarea, input, select, .resize-handle")) return;
    if (activeGroupId === groupId) return;
    activeGroupId = groupId;
    renderAll();
  });
}

// Click a card to make it the keyboard selection (the .selected ring + the node
// arrow keys / number keys act on). Ignores drag-releases and clicks on the
// card's own controls so normal editing is untouched.
function attachSelectClick(el, id) {
  el.addEventListener("click", (e) => {
    if (wasDragging) return;
    if (e.target.closest("button, textarea, input, select, .resize-handle")) return;
    if (selectedId === id) return;
    selectNote(id);
  });
}

// ── Drag-and-drop ─────────────────────────────────────────────

// Set true while a drag is moving the cursor, so the click that follows a
// drag-release doesn't get mistaken for a focus-selecting click.
let wasDragging = false;

function attachResize(el, note) {
  const handle = el.querySelector(".resize-handle");
  if (!handle) return;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = el.offsetWidth;
    const origH = el.offsetHeight;

    function move(e) {
      // Divide screen delta by zoom so the handle tracks the cursor 1:1 at any scale.
      const newW = Math.max(200, origW + (e.clientX - startX) / cam.k);
      const newH = Math.max(120, origH + (e.clientY - startY) / cam.k);
      el.style.width  = `${newW}px`;
      el.style.height = `${newH}px`;
    }
    function up() {
      note.width  = el.offsetWidth;
      note.height = el.offsetHeight;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      scheduleSave();
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// One header gesture, two outcomes:
//   • DRAG (move early) → freely reposition this node. It stays exactly where you
//     drop it (stored on note.x/note.y); NOTHING else moves. Connectors track live.
//   • HOLD STILL ~400ms → "lift" (armed) → release UNLINKS the node + subtree
//     into a standalone root (non-roots only; context-before dropped).
// A quick click does neither.
const LONG_PRESS_MS = 400;
const DRAG_THRESH = 6;
function attachNodeDrag(el, note) {
  const header = el.querySelector(".note-header");
  if (!header) return;

  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, textarea, select, .resize-handle")) return;
    e.preventDefault(); // suppress native text selection during press

    const sx = e.clientX, sy = e.clientY;
    const origX = parseFloat(el.style.left) || 0;
    const origY = parseFloat(el.style.top) || 0;
    // Capture this response's pill origins so they can be carried by the delta.
    const pillOrigins = [...document.querySelectorAll(`#orbits .orbit-move[data-resp="${note.id}"]`)]
      .map((p) => ({ el: p, move: p.dataset.move, x: parseFloat(p.style.left) || 0, y: parseFloat(p.style.top) || 0 }));
    let mode = null; // 'drag' | 'unlink'
    let rafPending = false;
    const canUnlink = !!note.parent_id;

    const timer = canUnlink
      ? setTimeout(() => { if (!mode) { mode = "unlink"; el.classList.add("lift"); } }, LONG_PRESS_MS)
      : null;

    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!mode && Math.hypot(dx, dy) > DRAG_THRESH) {
        mode = "drag";                 // moved before the hold armed → it's a drag
        if (timer) clearTimeout(timer);
        el.style.zIndex = 1000;
        el.classList.add("dragging");  // suppress the glide transition while dragging
      }
      if (mode === "drag") {
        el.style.left = `${origX + dx / cam.k}px`;
        el.style.top = `${origY + dy / cam.k}px`;
        // Carry this response's orbit pills along by the same world-space delta so
        // they stay attached to the card (and their tethers stay short).
        const wdx = dx / cam.k, wdy = dy / cam.k;
        const o = lastRender && lastRender.orbitPos[note.id];
        pillOrigins.forEach((po) => {
          const nx = po.x + wdx, ny = po.y + wdy;
          po.el.style.left = `${nx}px`;
          po.el.style.top = `${ny}px`;
          if (o && o[po.move]) o[po.move] = { x: nx, y: ny + MOVE_H / 2 };
        });
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => { rafPending = false; redrawWiresLive(note.id, "node"); });
        }
      }
    };
    const up = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.style.zIndex = "";
      el.classList.remove("dragging");
      if (mode === "drag") {
        // Store where it landed. No renderAll — the node stays put and nothing
        // else moves; the live redraw already left the wires correct.
        note.x = parseFloat(el.style.left);
        note.y = parseFloat(el.style.top);
        if (lastRender) lastRender.pos[note.id] = { x: note.x, y: note.y + el.offsetHeight / 2 };
        // Any PINNED pills that moved with the card keep their (new) pinned spot.
        pillOrigins.forEach((po) => {
          const key = `${note.id}:${po.move}`;
          if (pillPos[key]) pillPos[key] = { x: parseFloat(po.el.style.left), y: parseFloat(po.el.style.top) };
        });
        wasDragging = true; setTimeout(() => { wasDragging = false; }, 0);
        scheduleSave();
      } else if (mode === "unlink") {
        el.classList.remove("lift");
        wasDragging = true; setTimeout(() => { wasDragging = false; }, 0);
        detachToRoot(note.id);
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// Select text inside a response → a floating "break out" bubble appears; clicking
// it breaks the selected term out into a fresh tree (with a dashed origin link).
function attachSelectionBreakout(el, note) {
  const body = el.querySelector(".response-content");
  if (!body) return;
  body.addEventListener("mouseup", (e) => {
    e.stopPropagation();
    const sel = window.getSelection();
    const text = (sel && sel.toString() || "").trim();
    if (!text || text.length > 60) { hideBreakoutBubble(); return; }
    showBreakoutBubble(note.id, text, e.clientX, e.clientY);
  });
}

// The break-out bubble is a single floating element positioned in screen space.
let breakoutBubble = null;
function showBreakoutBubble(sourceId, term, clientX, clientY) {
  hideBreakoutBubble();
  const b = document.createElement("div");
  b.id = "breakout-bubble";
  b.textContent = `↗ break out “${term.length > 24 ? term.slice(0, 24) + "…" : term}”`;
  b.style.left = `${clientX}px`;
  b.style.top = `${clientY - 40}px`;
  b.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    breakOutTerm(sourceId, term);
    hideBreakoutBubble();
    window.getSelection().removeAllRanges();
  });
  document.body.appendChild(b);
  breakoutBubble = b;
}
function hideBreakoutBubble() {
  if (breakoutBubble) { breakoutBubble.remove(); breakoutBubble = null; }
}
// Dismiss the bubble on any click that isn't on it.
document.addEventListener("mousedown", (e) => {
  if (breakoutBubble && !e.target.closest("#breakout-bubble")) hideBreakoutBubble();
});

// ── Toolbar buttons ───────────────────────────────────────────

document.getElementById("btn-new-text").addEventListener("click", () => {
  const note = addNote("text");
  renderAll();
});
document.getElementById("btn-new-prompt").addEventListener("click", () => {
  const note = addNote("prompt");
  renderAll();
});
// Welcome-card CTA: create a prompt and focus it so the user can type the term.
document.getElementById("empty-add-prompt").addEventListener("click", () => addPromptAndFocus());
document.getElementById("btn-focus").addEventListener("click", (e) => {
  focusMode = !focusMode;
  if (focusMode) {
    document.body.dataset.focusMode = "on";
    // Pre-select a group so one stays bright immediately (avoids the
    // all-dimmed deadlock); keep any prior selection if it still exists.
    if (!activeGroupId || !notes.some((n) => n.id === activeGroupId)) {
      activeGroupId = firstGroupId();
    }
  } else {
    delete document.body.dataset.focusMode;
  }
  e.currentTarget.classList.toggle("active", focusMode);
  e.currentTarget.setAttribute("aria-pressed", String(focusMode));
  renderAll();
});
document.getElementById("btn-tidy").addEventListener("click", tidyTree);

// ── Camera controls: pan, zoom (buttons / Ctrl+wheel / keyboard) ──
// Manual card drag is gone (tidy-tree owns layout), so pan now works on the
// LEFT button over empty space, plus the middle button anywhere. A mousedown
// that lands on a card or control doesn't start a pan, so clicks/selection work.

(function initCamera() {
  const container = document.getElementById("canvas-container");
  let panning = false;
  let startX, startY, origCamX, origCamY;

  container.addEventListener("mousedown", (e) => {
    const onContent = e.target.closest(".note, #zoom-ui");
    const isPanButton = e.button === 1 || (e.button === 0 && !onContent);
    if (!isPanButton) return;
    e.preventDefault();
    panning = true;
    startX = e.clientX;
    startY = e.clientY;
    origCamX = cam.x;
    origCamY = cam.y;
    container.classList.add("panning");
  });

  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    cam.x = origCamX + (e.clientX - startX);
    cam.y = origCamY + (e.clientY - startY);
    applyCamera();
  });

  window.addEventListener("mouseup", () => {
    if (!panning) return;
    panning = false;
    container.classList.remove("panning");
  });

  container.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  // Wheel: Ctrl/⌘ + wheel zooms toward the cursor (trackpad pinch maps here too);
  // plain wheel pans the camera (vertical; Shift makes it horizontal). Plain-wheel
  // pan replaces the native scroll lost when the container went overflow:hidden, so
  // trackpad / no-middle-button users can still move around.
  container.addEventListener("wheel", (e) => {
    // If the pointer is over a scrollable region inside a note (a long answer or
    // a note textarea) that can still scroll in the wheel's direction, let the
    // browser scroll it instead of panning the canvas. Without this the canvas
    // ate every wheel event and you had to grab the tiny in-note scrollbar.
    if (!e.ctrlKey && !e.metaKey) {
      const sc = e.target.closest(".response-content, .note textarea");
      if (sc && sc.scrollHeight > sc.clientHeight + 1) {
        const down = e.deltaY > 0 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1;
        const up = e.deltaY < 0 && sc.scrollTop > 0;
        if (down || up) return; // native scroll handles it; don't pan
      }
    }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = container.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(e.clientX - r.left, e.clientY - r.top, cam.k * factor);
    } else {
      cam.x -= e.shiftKey ? e.deltaY : e.deltaX;
      cam.y -= e.shiftKey ? 0 : e.deltaY;
      applyCamera();
    }
  }, { passive: false });

  // Double-click empty canvas → drop a prompt note right where you clicked (and
  // focus it), so you don't have to travel to the toolbar to start a thought.
  // Ignored on cards/controls so double-clicking text/headers still behaves.
  container.addEventListener("dblclick", (e) => {
    if (e.target.closest(".note, #zoom-ui, #empty-state, #coach-orbit, #coach-keys, #board-menu")) return;
    const r = container.getBoundingClientRect();
    const wx = (e.clientX - r.left - cam.x) / cam.k;
    const wy = (e.clientY - r.top - cam.y) / cam.k;
    addPromptAndFocus({ x: wx, y: wy });
  });
})();

// Zoom UI buttons
document.getElementById("zoom-in").addEventListener("click", () => {
  const c = viewportCenter();
  zoomAt(c.x, c.y, cam.k * 1.25);
});
document.getElementById("zoom-out").addEventListener("click", () => {
  const c = viewportCenter();
  zoomAt(c.x, c.y, cam.k / 1.25);
});
document.getElementById("zoom-fit").addEventListener("click", fitAll);

// Create a prompt note and focus its textarea so the user can type immediately.
// Shared by the welcome CTA, the "n" shortcut, and double-click-to-create. With
// an explicit {x, y} (world coords) the note lands there; otherwise it's placed
// near the viewport like the toolbar button.
function addPromptAndFocus(at) {
  const note = addNote("prompt", at || {});
  renderAll();
  const ta = canvas.querySelector(`.note[data-id="${note.id}"] textarea`);
  if (ta) ta.focus();
  return note;
}

// Keyboard map. View/create: + − zoom, 0 fit, n prompt, t text, ? shortcuts.
// Tree navigation (on the current selection): arrows walk it, 1–9 fire the
// selected response's orbit moves, Enter runs a selected prompt, Del removes it,
// Esc deselects. Ignored while typing in a field or behind an open modal.
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (!modalEls.overlay.hidden) return; // don't act behind an open dialog
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser/OS combos alone

  // ? toggles the keyboard cheat-sheet (Shift+/). Works any time.
  if (e.key === "?") { e.preventDefault(); toggleKeysCoach(); return; }

  // Arrow keys walk the thought-tree from the current selection.
  const arrows = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" };
  if (e.key in arrows) { e.preventDefault(); dismissKeysCoach(); navigate(arrows[e.key]); return; }

  // 1–9 fire the selected response's orbit moves.
  if (selectedId && e.key >= "1" && e.key <= "9") {
    e.preventDefault(); dismissKeysCoach(); fireOrbitByNumber(Number(e.key)); return;
  }

  // Enter runs a selected ROOT prompt (clicks its Run button, reusing the build).
  if (e.key === "Enter" && selectedId) {
    const sel = notes.find((n) => n.id === selectedId);
    if (sel && sel.type === "prompt") {
      const runBtn = canvas.querySelector(`.note[data-id="${selectedId}"] .btn-run`);
      if (runBtn) { e.preventDefault(); runBtn.click(); return; }
    }
  }

  // Del / Backspace soft-deletes the selected node (undoable).
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault(); deleteNote(selectedId); return;
  }

  // Esc clears the selection.
  if (e.key === "Escape" && selectedId) { selectedId = null; renderAll(); return; }

  if (e.key === "+" || e.key === "=") {
    const c = viewportCenter();
    zoomAt(c.x, c.y, cam.k * 1.25);
  } else if (e.key === "-" || e.key === "_") {
    const c = viewportCenter();
    zoomAt(c.x, c.y, cam.k / 1.25);
  } else if (e.key === "0") {
    fitAll();
  } else if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    addPromptAndFocus();
  } else if (e.key === "t" || e.key === "T") {
    e.preventDefault();
    addNote("text");
    renderAll();
  } else if (e.key === "f" || e.key === "F") {
    // Toggle focus mode — reuse the toolbar button's own handler so the active
    // state, aria-pressed, and group pre-selection all stay in one place.
    e.preventDefault();
    document.getElementById("btn-focus").click();
  }
});

// ── Board switcher events ─────────────────────────────────────

boardSelect.addEventListener("change", (e) => switchBoard(e.target.value));
// Double-click the board name → rename it (a quick, discoverable shortcut for
// the menu's Rename). preventDefault stops the native dropdown from opening.
boardSelect.addEventListener("dblclick", (e) => { e.preventDefault(); renameBoard(); });
document.getElementById("btn-new-board").addEventListener("click", () => newBoard());

// Board-actions kebab menu (⋯): consolidates rename + delete behind one labelled
// control instead of two cryptic glyph buttons. Opens a small popover; closes on
// pick, outside click, or Esc.
const boardMenu = document.getElementById("board-menu");
const btnBoardMenu = document.getElementById("btn-board-menu");
function setBoardMenu(open) {
  boardMenu.hidden = !open;
  btnBoardMenu.setAttribute("aria-expanded", String(open));
}
btnBoardMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  setBoardMenu(boardMenu.hidden);
});
document.getElementById("menu-rename-board").addEventListener("click", () => { setBoardMenu(false); renameBoard(); });
document.getElementById("menu-delete-board").addEventListener("click", () => { setBoardMenu(false); deleteBoard(); });
// Dismiss the menu on any outside click or Esc.
document.addEventListener("click", (e) => {
  if (!boardMenu.hidden && !e.target.closest("#board-menu-wrap")) setBoardMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !boardMenu.hidden) setBoardMenu(false);
});

// ── Boot ──────────────────────────────────────────────────────

applyCamera();
loadBoard().then(() => {
  fitAll();
  refreshBoardList();
});
