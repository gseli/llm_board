const BOARD_NAME = "default";
const NOTE_HEIGHT_ESTIMATE = 220;
const NOTE_GAP = 20;

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
    ...extra,
  };
  notes.push(note);
  renderNote(note);
  scheduleSave();
}

function deleteNote(id) {
  // also delete any response children
  const children = notes.filter((n) => n.parent_id === id);
  children.forEach((c) => deleteNote(c.id));
  notes = notes.filter((n) => n.id !== id);
  renderAll();
  scheduleSave();
}

function updateNote(id, fields) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  Object.assign(note, fields);
  scheduleSave();
}

// ── Prompt execution ─────────────────────────────────────────

async function runPrompt(parentId, builtPrompt) {
  // Remove existing response child if any
  const existing = notes.find((n) => n.parent_id === parentId && n.type === "response");
  if (existing) {
    notes = notes.filter((n) => n.id !== existing.id);
  }

  const parent = notes.find((n) => n.id === parentId);
  if (!parent) return;

  const responseNote = {
    id: generateId(),
    type: "response",
    x: parent.x,
    y: parent.y + NOTE_HEIGHT_ESTIMATE + NOTE_GAP,
    content: "",
    parent_id: parentId,
    loading: true,
  };
  notes.push(responseNote);
  renderAll();

  // Disable run button while loading
  const parentEl = canvas.querySelector(`[data-id="${parentId}"]`);
  if (parentEl) {
    const btn = parentEl.querySelector(".btn-run");
    if (btn) btn.disabled = true;
  }

  try {
    const res = await fetch("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: builtPrompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Unknown error");
    responseNote.content = data.response;
  } catch (err) {
    responseNote.content = `Error: ${err.message}`;
  } finally {
    responseNote.loading = false;
    renderAll();
    scheduleSave();
    const parentEl2 = canvas.querySelector(`[data-id="${parentId}"]`);
    if (parentEl2) {
      const btn = parentEl2.querySelector(".btn-run");
      if (btn) btn.disabled = false;
    }
  }
}

// ── Rendering ─────────────────────────────────────────────────

function renderAll() {
  canvas.innerHTML = "";
  // Render text notes standalone
  notes.filter((n) => n.type === "text").forEach((note) => {
    const el = createNoteElement(note, deleteNote, runPrompt, updateNote);
    makeDraggable(el, note);
    canvas.appendChild(el);
  });
  // Render prompt notes as groups (prompt + optional connector + response)
  notes.filter((n) => n.type === "prompt").forEach((note) => {
    renderPromptGroup(note);
  });
}

function renderNote(note) {
  if (note.type === "prompt") {
    renderPromptGroup(note);
  } else if (note.type === "text") {
    const el = createNoteElement(note, deleteNote, runPrompt, updateNote);
    makeDraggable(el, note);
    canvas.appendChild(el);
  }
  // response notes are rendered inside renderPromptGroup, never standalone
}

function renderPromptGroup(promptNote) {
  const group = document.createElement("div");
  group.dataset.groupId = promptNote.id;
  group.style.position = "absolute";
  group.style.left = `${promptNote.x}px`;
  group.style.top = `${promptNote.y}px`;
  group.style.display = "flex";
  group.style.flexDirection = "column";

  const promptEl = createNoteElement(promptNote, deleteNote, runPrompt, updateNote);
  promptEl.style.left = "";
  promptEl.style.top = "";
  promptEl.style.position = "relative";
  attachResize(promptEl, promptNote);
  group.appendChild(promptEl);

  const child = notes.find((n) => n.parent_id === promptNote.id && n.type === "response");
  if (child) {
    const connector = document.createElement("div");
    connector.className = "note-connector";
    group.appendChild(connector);

    const responseEl = createNoteElement(child, deleteNote, runPrompt, updateNote);
    responseEl.style.left = "";
    responseEl.style.top = "";
    responseEl.style.position = "relative";
    attachResize(responseEl, child);
    group.appendChild(responseEl);
  }

  makeDraggableGroup(group, promptNote);
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
  let startX, startY, origX, origY;

  handle.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("btn-delete")) return;
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

document.getElementById("btn-new-text").addEventListener("click", () => addNote("text"));
document.getElementById("btn-new-prompt").addEventListener("click", () => addNote("prompt"));

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

  // prevent the browser's default middle-click scroll autoscroll indicator
  container.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
})();

// ── Boot ──────────────────────────────────────────────────────

loadBoard();
