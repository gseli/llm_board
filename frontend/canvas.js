const BOARD_NAME = "default";

let notes = [];
let saveTimer = null;

const canvas = document.getElementById("canvas");
const saveStatus = document.getElementById("save-status");

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
  const container = document.getElementById("canvas-container");
  const scrollX = container.scrollLeft + 80;
  const scrollY = container.scrollTop + 80;

  const note = {
    id: generateId(),
    type,
    x: scrollX + Math.random() * 60,
    y: scrollY + Math.random() * 40,
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
    } else if (current.type === "prompt" && current.content) {
      // Reconstruct what was actually sent for this prompt
      const tpl = TEMPLATES.find((t) => t.id === (current.prompt_template || "explain_term")) || TEMPLATES[0];
      messages.unshift({ role: "user", content: tpl.build(current.content.trim() || "this concept") });
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
    canvas.appendChild(el);
  });

  // Render root prompt notes as chains (prompt nodes with no prompt parent)
  notes
    .filter((n) => n.type === "prompt" && !notes.some((p) => p.id === n.parent_id && p.type === "response"))
    .forEach((note) => renderChain(note));
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
    const el = createNoteElement(current, deleteNote, runPrompt, updateNote, replyToResponse);
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

  canvas.appendChild(group);
}

// ── Drag-and-drop ─────────────────────────────────────────────

function makeDraggable(el, note) {
  const header = el.querySelector(".note-header");
  attachDrag(header, el, note, (x, y) => {
    note.x = x; note.y = y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  });
  attachResize(el, note);
}

function makeDraggableGroup(groupEl, promptNote) {
  const header = groupEl.querySelector(".note-header");
  attachDrag(header, groupEl, promptNote, (x, y) => {
    promptNote.x = x; promptNote.y = y;
    groupEl.style.left = `${x}px`;
    groupEl.style.top = `${y}px`;
  });
}

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
      onMove(origX + (e.clientX - startX), origY + (e.clientY - startY));
    }
    function up() {
      container.style.zIndex = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      scheduleSave();
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
      const newW = Math.max(200, origW + (e.clientX - startX));
      const newH = Math.max(120, origH + (e.clientY - startY));
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

// ── MMB pan ───────────────────────────────────────────────────

(function initPan() {
  const container = document.getElementById("canvas-container");
  let panning = false;
  let startX, startY, scrollX, scrollY;

  container.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    panning = true;
    startX = e.clientX;
    startY = e.clientY;
    scrollX = container.scrollLeft;
    scrollY = container.scrollTop;
    container.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    container.scrollLeft = scrollX - (e.clientX - startX);
    container.scrollTop  = scrollY - (e.clientY - startY);
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 1) return;
    panning = false;
    container.style.cursor = "";
  });

  container.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
})();

// ── Boot ──────────────────────────────────────────────────────

loadBoard();
