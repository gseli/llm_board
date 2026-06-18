const BOARD_NAME = "default";

let notes = [];
let saveTimer = null;

// Focus mode is view-only state — never persisted to `notes` / board JSON.
let focusMode = false;     // dim every group except the active one?
let activeGroupId = null;  // dataset id of the focused group (chain root id, or a text note id)

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
  const els = [...canvas.querySelectorAll(":scope > .note, :scope > [data-group-id]")];
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

// ── Persistence ──────────────────────────────────────────────

async function loadBoard() {
  const res = await fetch(`/board/${BOARD_NAME}`);
  const data = await res.json();
  notes = data.notes || [];
  renderAll();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus("saving");
  saveTimer = setTimeout(async () => {
    await fetch(`/board/${BOARD_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus(""), 1500);
  }, 500);
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
  // Place near the viewport's top-left in WORLD coords (inverse camera transform),
  // so a new note lands on-screen regardless of pan/zoom.
  const r = document.getElementById("canvas-container").getBoundingClientRect();
  const worldX = (r.width * 0.18 - cam.x) / cam.k;
  const worldY = (r.height * 0.18 - cam.y) / cam.k;

  const note = {
    id: generateId(),
    type,
    x: worldX + Math.random() * 60,
    y: worldY + Math.random() * 40,
    content: "",
    prompt_template: "explain_term",
    parent_id: null,
    thread_id: null,
    conversation_context: null,
    conversation: null,
    ...extra,
  };
  notes.push(note);
  scheduleSave();
  return note;
}

// Each entry is one deletion's full subtree (root + descendants). Newest last;
// undo pops the most recent. Capped at UNDO_LIMIT — oldest dropped past the cap.
const undoStack = [];
const UNDO_LIMIT = 10;

function deleteNote(id) {
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
        const move = EXPLORE_MOVES.find((m) => m.id === current.prompt_template);
        if (move) built = move.build(text);
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

function replyToResponse(responseNoteId) {
  const responseNote = notes.find((n) => n.id === responseNoteId);
  if (!responseNote) return;

  // Don't allow reply while response is loading
  if (responseNote.loading) return;

  // Don't allow a second follow-up if one already exists
  const alreadyHasFollowUp = notes.some((n) => n.parent_id === responseNoteId && n.type === "prompt");
  if (alreadyHasFollowUp) return;

  const history = buildHistory(responseNoteId);
  const threadId = responseNote.thread_id || responseNote.parent_id;

  addNote("prompt", {
    parent_id: responseNoteId,
    thread_id: threadId,
    conversation_context: history,
    x: responseNote.x,
    y: 0, // position managed by renderChain
  });

  renderAll();
}

// One-click explore: build the move's prompt, create (or replace) the follow-up
// prompt node under this response, and run it immediately — no separate compose step.
function exploreFromResponse(responseNoteId, move, inputText) {
  const responseNote = notes.find((n) => n.id === responseNoteId);
  if (!responseNote || responseNote.loading) return;

  // Replace any existing follow-up under this response (re-running a move overwrites,
  // mirroring runPrompt's stale-response handling). deleteNote cleans up its subtree.
  const existingFollowUp = notes.find((n) => n.parent_id === responseNoteId && n.type === "prompt");
  if (existingFollowUp) {
    const ids = new Set();
    (function collect(id) { ids.add(id); notes.filter((n) => n.parent_id === id).forEach((c) => collect(c.id)); })(existingFollowUp.id);
    notes = notes.filter((n) => !ids.has(n.id));
  }

  const history = buildHistory(responseNoteId);
  const threadId = responseNote.thread_id || responseNote.parent_id;

  const followUp = addNote("prompt", {
    parent_id: responseNoteId,
    thread_id: threadId,
    conversation_context: history,
    prompt_template: move.id,
    content: inputText || "",
    x: responseNote.x,
    y: 0, // position managed by renderChain
  });

  runPrompt(followUp.id, move.build(inputText || ""));
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
    x: parent.x,
    y: 0, // managed by renderChain
    content: "",
    parent_id: parentId,
    thread_id: parent.thread_id || parentId,
    conversation: null,
    loading: true,
  };
  notes.push(responseNote);
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

function renderAll() {
  canvas.innerHTML = "";

  // Render standalone text notes
  notes.filter((n) => n.type === "text").forEach((note) => {
    const el = createNoteElement(note, deleteNote, runPrompt, updateNote, null);
    makeDraggable(el, note);
    applyFocus(el, note.id);
    attachFocusClick(el, note.id);
    canvas.appendChild(el);
  });

  // Render root prompt notes as chains (prompt nodes with no prompt parent)
  notes
    .filter((n) => n.type === "prompt" && !notes.some((p) => p.id === n.parent_id && p.type === "response"))
    .forEach((note) => renderChain(note));
}

// In focus mode, dim every top-level group whose id isn't the active one.
// Derived/visual only — applied during renderAll, never persisted.
function applyFocus(el, groupId) {
  if (focusMode && groupId !== activeGroupId) el.classList.add("dimmed");
}

// The first top-level group in render order (text notes first, then chain roots),
// mirroring renderAll. Used to pre-select a group when focus mode turns on so the
// view is never "everything dimmed, nothing bright". null on an empty board.
function firstGroupId() {
  const firstText = notes.find((n) => n.type === "text");
  if (firstText) return firstText.id;
  const firstRoot = notes.find(
    (n) => n.type === "prompt" && !notes.some((p) => p.id === n.parent_id && p.type === "response")
  );
  return firstRoot ? firstRoot.id : null;
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

function renderChain(rootPrompt) {
  const group = document.createElement("div");
  group.dataset.groupId = rootPrompt.id;
  group.style.position = "absolute";
  group.style.left = `${rootPrompt.x}px`;
  group.style.top = `${rootPrompt.y}px`;
  group.style.display = "flex";
  group.style.flexDirection = "column";

  let current = rootPrompt;
  let isFirst = true;

  while (current) {
    const el = createNoteElement(current, deleteNote, runPrompt, updateNote, replyToResponse, exploreFromResponse);
    el.style.left = "";
    el.style.top = "";
    el.style.position = "relative";

    attachResize(el, current);
    group.appendChild(el);

    if (isFirst) {
      // Wire drag after the first card is in the DOM so querySelector finds the header
      makeDraggableGroup(group, rootPrompt);
      isFirst = false;
    }

    // Find child: response of this prompt, or follow-up prompt of this response
    const child = notes.find((n) => n.parent_id === current.id);
    if (child) {
      const connector = document.createElement("div");
      connector.className = "note-connector";
      group.appendChild(connector);
      current = child;
    } else {
      current = null;
    }
  }

  applyFocus(group, rootPrompt.id);
  attachFocusClick(group, rootPrompt.id);
  canvas.appendChild(group);
}

// ── Drag-and-drop ─────────────────────────────────────────────

// Manual node positioning is gone — the tidy-tree layout owns every node's
// position now (see layoutForest). Cards keep resize; dragging to reposition is
// a no-op. (The only drag that returns is gestural long-press detach, slice #25.)
function makeDraggable(el, note) {
  attachResize(el, note);
}

function makeDraggableGroup(_groupEl, _promptNote) {
  // no-op: layout is auto-computed; nodes are not hand-positioned
}

// Set true while a drag is moving the cursor, so the click that follows a
// drag-release doesn't get mistaken for a focus-selecting click.
let wasDragging = false;

function attachDrag(handle, container, note, onMove) {
  if (!handle) return;
  let startX, startY, origX, origY;

  handle.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("btn-delete")) return;
    if (e.target.classList.contains("btn-reply")) return;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    origX = note.x;
    origY = note.y;
    container.style.zIndex = 1000;

    function move(e) {
      if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) wasDragging = true;
      // Divide screen delta by zoom so the card tracks the cursor 1:1 at any scale.
      onMove(origX + (e.clientX - startX) / cam.k, origY + (e.clientY - startY) / cam.k);
    }
    function up() {
      container.style.zIndex = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      scheduleSave();
      // Clear after the click that follows this mouseup has been dispatched.
      setTimeout(() => { wasDragging = false; }, 0);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

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

// ── Toolbar buttons ───────────────────────────────────────────

document.getElementById("btn-new-text").addEventListener("click", () => {
  const note = addNote("text");
  renderAll();
});
document.getElementById("btn-new-prompt").addEventListener("click", () => {
  const note = addNote("prompt");
  renderAll();
});
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
  renderAll();
});

// ── Camera controls: pan, zoom (buttons / Ctrl+wheel / keyboard) ──
// Slice 1: pan stays on the MIDDLE mouse button so it never collides with
// left-button card drag (cards are still freely draggable this slice). A later
// slice moves pan to left-drag-on-empty-space once card drag is removed.

(function initCamera() {
  const container = document.getElementById("canvas-container");
  let panning = false;
  let startX, startY, origCamX, origCamY;

  container.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return; // middle button only
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

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 1) return;
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

// Keyboard: + / − zoom around center, 0 fits all. Ignored while typing.
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "+" || e.key === "=") {
    const c = viewportCenter();
    zoomAt(c.x, c.y, cam.k * 1.25);
  } else if (e.key === "-" || e.key === "_") {
    const c = viewportCenter();
    zoomAt(c.x, c.y, cam.k / 1.25);
  } else if (e.key === "0") {
    fitAll();
  }
});

// ── Boot ──────────────────────────────────────────────────────

applyCamera();
loadBoard().then(() => fitAll());
