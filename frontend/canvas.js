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
  pillPos = data.pill_pos || {};
  const legacy = data.layout !== "tree" && notes.length > 0;
  layout = "tree";
  renderAll();
  // A pre-tree (vertical) board has stale x/y — tidy once to lay it out
  // horizontally and store the positions, then it's stable like any tree board.
  if (legacy) tidyTree();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus("saving");
  saveTimer = setTimeout(async () => {
    await fetch(`/board/${BOARD_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes, layout, pill_pos: pillPos }),
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
function computeForest(heights) {
  const pos = {};
  let top = 0;
  forestRoots().forEach((root) => {
    top += assignLayout(root, 0, top, pos, heights) + TREE_GAP;
  });
  return pos;
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
      note, deleteNote, runPrompt, updateNote, replyToResponse, exploreFromResponse
    );
    el.style.position = "absolute";
    el.style.left = `${note.x || 0}px`;
    el.style.top = `${note.y || 0}px`;
    el.dataset.id = note.id;
    attachResize(el, note);
    attachNodeDrag(el, note);        // free per-node drag + long-press unlink
    if (note.type === "response") attachSelectionBreakout(el, note);
    const rootId = rootOf(note.id);
    applyFocus(el, rootId);
    attachFocusClick(el, rootId);
    canvas.appendChild(el);
    cards[note.id] = el;
    pos[note.id] = { x: note.x || 0, y: (note.y || 0) + el.offsetHeight / 2 };
  });

  const orbitPos = buildOrbits(orbitLayer, pos, cards);
  drawWires(svg, pos, cards, orbitPos);

  lastRender = { svg, pos, cards, orbitPos };
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

// The user-invoked tidy: run the tidy-tree layout once and GLIDE the existing
// cards into place — the only time the canvas moves on its own. It animates the
// live DOM (rather than re-rendering) so cards transition from their current
// spots; wires are redrawn each frame during the glide. Pills snap back to their
// default orbit. Soft, slow easing ("leaves settling"), never an abrupt snap.
function tidyTree() {
  const heights = {};
  const measured = {};
  document.querySelectorAll("#canvas > .note").forEach((el) => {
    heights[el.dataset.id] = el.offsetHeight;
    measured[el.dataset.id] = el;
  });
  const pos = computeForest(heights); // {id:{x, y-center}}

  pillPos = {}; // pills return to their orbit

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
      const pill = buildOrbitPill(note, move, usedMoveIds.has(move.id), dimmed);
      pill.style.left = `${left}px`;
      pill.style.top = `${top}px`;
      pill.dataset.resp = note.id;       // so a dragged response can carry its pills
      pill.dataset.move = move.id;
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
function buildOrbitPill(note, move, spent, dimmed) {
  const pill = document.createElement("div");
  pill.className = "orbit-move" + (move.ask ? " ask" : "") + (move.breakout ? " breakout" : "")
    + (spent ? " spent" : "") + (dimmed ? " dimmed" : "");

  const label = document.createElement("button");
  label.className = "orbit-label";
  label.textContent = move.label;
  pill.appendChild(label);

  if (move.ask) {
    label.addEventListener("click", (e) => { e.stopPropagation(); if (wasDragging) return; replyToResponse(note.id); });
    return pill;
  }
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
