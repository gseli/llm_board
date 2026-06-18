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

// Board-level layout flag. A board without it is a pre-tree (vertical) board;
// since vertical chains are already linear trees, migration is just stamping
// the flag — the tidy-tree renderer lays the existing chains out horizontally
// with no structural change. Re-saved on next persist.
let layout = "tree";

async function loadBoard() {
  const res = await fetch(`/board/${BOARD_NAME}`);
  const data = await res.json();
  notes = data.notes || [];
  const needsStamp = data.layout !== "tree" && notes.length > 0;
  layout = "tree";
  renderAll();
  // Persist the migration stamp on first load of a real (non-empty) legacy board.
  // Skip empty boards so merely visiting an unknown board name doesn't create a file.
  if (needsStamp) scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus("saving");
  saveTimer = setTimeout(async () => {
    await fetch(`/board/${BOARD_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes, layout }),
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
  if (responseNote.loading) return;

  // Free forking: a response can have many follow-ups. No one-child guard.
  const history = buildHistory(responseNoteId);
  const threadId = responseNote.thread_id || responseNote.parent_id;

  addNote("prompt", {
    parent_id: responseNoteId,
    thread_id: threadId,
    conversation_context: history,
    prompt_template: null, // free-text reply — not an explore move (no spent/orbit match)
  });

  renderAll();
}

// One-click explore: build the move's prompt, create a NEW follow-up branch under
// this response (free forking — many children allowed), and run it in one step.
function exploreFromResponse(responseNoteId, move, inputText) {
  const responseNote = notes.find((n) => n.id === responseNoteId);
  if (!responseNote || responseNote.loading) return;

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

// Tidy-tree layout constants (world px).
const COL_W = 470;     // horizontal distance between depth columns (room for the orbit gutter)
const ROW_GAP = 28;    // vertical gap between sibling subtrees
const TREE_GAP = 70;   // vertical gap between top-level trees
const FALLBACK_H = 150; // assumed card height before it has been measured

// Orbit (floating explore-move pills shown right of each response).
const ORBIT_GAP = 14;  // gap between a response's right edge and its orbit pills
const ORBIT_W = 132;   // orbit pill width
const MOVE_H = 27;      // orbit pill height
const ORBIT_VGAP = 6;  // vertical gap between orbit pills

// The pills shown on a response: every explore move + an "ask your own" entry.
// Shared by orbitHeightFor (layout reservation) and the renderer so they agree.
function orbitMovesFor(note) {
  const content = (note.content || "").trim();
  // Eligible: a response that has a real answer (not loading, not an error).
  if (note.type !== "response" || note.loading || !content || content.startsWith("Error:")) return [];
  return [
    ...EXPLORE_MOVES,
    { id: "__newtree__", label: "↗ new tree", needsInput: true, inputPlaceholder: "which term?", breakout: true },
    { id: "__ask__", label: "↩ ask your own", ask: true },
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

// Assign world x/y to every visible node in a subtree. By default x is by depth
// and y centers the node on its subtree band (siblings never overlap). A node the
// user dragged (manual_x/manual_y pinned) sits at its pin, and its whole subtree
// lays out relative to that pin so it travels with the node.
//   x: column origin for this node's children
//   top: top of the vertical band these nodes occupy
function assignLayout(note, x, top, pos, heights, seen = new Set()) {
  if (seen.has(note.id)) return 0;
  seen.add(note.id);
  const band = subtreeHeight(note, heights);
  const pinned = note.manual_x != null && note.manual_y != null;
  const nx = pinned ? note.manual_x : x;
  const ny = pinned ? note.manual_y : top + band / 2;
  pos[note.id] = { x: nx, y: ny };
  // Children flow from this node's actual position (so a pinned/dragged node
  // carries its subtree). Center the children band on this node's y.
  const childTotal = displayChildrenOf(note.id)
    .reduce((s, k) => s + subtreeHeight(k.node, heights), 0)
    + ROW_GAP * Math.max(0, displayChildrenOf(note.id).length - 1);
  let cursor = ny - childTotal / 2;
  displayChildrenOf(note.id).forEach((k) => {
    const kBand = subtreeHeight(k.node, heights);
    assignLayout(k.node, nx + COL_W, cursor, pos, heights, seen);
    cursor += kBand + ROW_GAP;
  });
  return band;
}

// Lay out the whole forest given measured card heights, writing pos[id]={x,y}.
function computeForest(heights) {
  const pos = {};
  let top = 0;
  forestRoots().forEach((root) => {
    top += assignLayout(root, 0, top, pos, heights) + TREE_GAP;
  });
  return pos;
}

function renderAll() {
  canvas.innerHTML = "";

  // SVG wire layer underneath the cards (parent→child connectors).
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "wires";
  canvas.appendChild(svg);
  // Orbit layer (floating move pills) above the wires, below the cards.
  const orbitLayer = document.createElement("div");
  orbitLayer.id = "orbits";
  canvas.appendChild(orbitLayer);

  // Pass 1: render every card at its column x (top temporary) so it's in the DOM
  // and measurable. Orphans (parent_id set but parent gone) get no column and are
  // skipped — warn so a silently-lost note is at least visible in the console.
  const cards = {};
  const provisional = computeForest({}); // x is height-independent; gives columns
  notes.forEach((note) => {
    if (isHiddenPrompt(note)) return; // follow-up prompts render no card (pass-through)
    const p = provisional[note.id];
    if (!p) {
      if (note.parent_id) console.warn("Orphaned note (parent missing), not rendered:", note.id);
      return;
    }
    const el = createNoteElement(
      note, deleteNote, runPrompt, updateNote, replyToResponse, exploreFromResponse
    );
    el.style.position = "absolute";
    el.style.left = `${p.x}px`;
    el.style.top = "0px";
    el.dataset.id = note.id;
    attachResize(el, note);
    attachNodeDrag(el, note);        // free per-node drag + long-press unlink
    if (note.type === "response") attachSelectionBreakout(el, note);
    const rootId = rootOf(note.id);
    applyFocus(el, rootId);
    attachFocusClick(el, rootId);
    canvas.appendChild(el);
    cards[note.id] = el;
  });

  // Pass 2: measure real heights, recompute the forest, place cards.
  const heights = {};
  Object.entries(cards).forEach(([id, el]) => { heights[id] = el.offsetHeight; });
  const pos = computeForest(heights);
  Object.entries(cards).forEach(([id, el]) => {
    const p = pos[id];
    if (p) { el.style.left = `${p.x}px`; el.style.top = `${p.y - el.offsetHeight / 2}px`; }
  });

  // Build orbit pills (before wires, so wire routing can use pill positions).
  const orbitPos = buildOrbits(orbitLayer, pos, cards);
  drawWires(svg, pos, cards, orbitPos);

  // Keep the render state so a live drag can redraw just the wires without a
  // full renderAll on every mousemove.
  lastRender = { svg, pos, cards, orbitPos };
}

// Latest render state, used by redrawWiresLive during a drag.
let lastRender = null;

// Redraw wires against the dragged node's CURRENT on-screen position (read from
// the DOM), patching the stale layout `pos` so connectors track the card live.
function redrawWiresLive(draggedId) {
  if (!lastRender) return;
  const { svg, pos, cards, orbitPos } = lastRender;
  const el = cards[draggedId];
  if (el) {
    pos[draggedId] = { x: el.offsetLeft, y: el.offsetTop + el.offsetHeight / 2 };
  }
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
    // Clamp into the gutter so a user-widened card can't push pills into the
    // child column at p.x + COL_W (which would overlap forked child cards).
    const orbitX = Math.min(p.x + cardW + ORBIT_GAP, p.x + COL_W - ORBIT_W - ORBIT_GAP);
    const blockH = moves.length * MOVE_H + (moves.length - 1) * ORBIT_VGAP;
    const firstTop = p.y - blockH / 2;
    // A move is "spent" if a child prompt under this response already used it.
    const usedMoveIds = new Set(childrenOf(note.id).map((c) => c.prompt_template));
    const dimmed = focusMode && rootOf(note.id) !== activeGroupId;
    orbitPos[note.id] = {};

    moves.forEach((move, i) => {
      const top = firstTop + i * (MOVE_H + ORBIT_VGAP);
      orbitPos[note.id][move.id] = { x: orbitX, y: top + MOVE_H / 2 };
      const pill = buildOrbitPill(note, move, usedMoveIds.has(move.id), dimmed);
      pill.style.left = `${orbitX}px`;
      pill.style.top = `${top}px`;
      layer.appendChild(pill);
    });
  });
  return orbitPos;
}

// One orbit pill. Non-input moves fork on click; needsInput moves toggle a tiny
// inline input (Enter submits, Esc cancels); the ask pill opens the reply path.
function buildOrbitPill(note, move, spent, dimmed) {
  const pill = document.createElement("div");
  pill.className = "orbit-move" + (move.ask ? " ask" : "") + (move.breakout ? " breakout" : "")
    + (spent ? " spent" : "") + (dimmed ? " dimmed" : "");

  const label = document.createElement("button");
  label.className = "orbit-label";
  label.textContent = move.label;
  pill.appendChild(label);

  if (move.ask) {
    label.addEventListener("click", (e) => { e.stopPropagation(); replyToResponse(note.id); });
    return pill;
  }
  if (!move.needsInput) {
    label.addEventListener("click", (e) => { e.stopPropagation(); exploreFromResponse(note.id, move, ""); });
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
//   • DRAG (move early) → reposition this node freely, pinning manual_x/manual_y
//     so the tidy-tree flows around it instead of overwriting your placement.
//   • HOLD STILL ~400ms → "lift" (armed) → release UNLINKS the node + subtree
//     into a standalone root (non-roots only; context-before dropped).
// A quick click does neither. The whole subtree shifts with a dragged node, since
// children auto-flow from its (now pinned) position.
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
    const origX = (note.manual_x != null) ? note.manual_x : parseFloat(el.style.left) || 0;
    const origY = (note.manual_y != null) ? note.manual_y : (parseFloat(el.style.top) || 0) + el.offsetHeight / 2;
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
      }
      if (mode === "drag") {
        const nx = origX + dx / cam.k, ny = origY + dy / cam.k;
        el.style.left = `${nx}px`;
        el.style.top = `${ny - el.offsetHeight / 2}px`;
        // Redraw connectors live, throttled to one repaint per frame.
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => { rafPending = false; redrawWiresLive(note.id); });
        }
      }
    };
    const up = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.style.zIndex = "";
      if (mode === "drag") {
        note.manual_x = parseFloat(el.style.left);
        note.manual_y = parseFloat(el.style.top) + el.offsetHeight / 2;
        wasDragging = true; setTimeout(() => { wasDragging = false; }, 0);
        renderAll();      // re-flow children around the pinned position + redraw wires
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
