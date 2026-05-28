const TEMPLATES = [
  {
    id: "explain_term",
    label: "Explain term",
    build: (input) => `Explain the term "${input}" in simple language. Be concise.`,
  },
  {
    id: "define_concept",
    label: "Define concept",
    build: (input) => `Give a concise, clear definition of "${input}".`,
  },
  {
    id: "eli5",
    label: "Explain like I'm 5",
    build: (input) => `Explain "${input}" like I'm 5 years old.`,
  },
  {
    id: "five_levels",
    label: "5 levels of understanding",
    build: (input) =>
      `Explain "${input}" at 5 levels of understanding. Use a separate paragraph for each:\n` +
      `1. Child\n2. Teenager\n3. College student\n4. Graduate student\n5. Domain expert`,
  },
  {
    id: "relate_to",
    label: "How does it relate?",
    build: (input) => `How does "${input}" relate to other concepts in its field? Give 2–3 connections.`,
  },
];

function makeResizeHandle() {
  const handle = document.createElement("div");
  handle.className = "resize-handle";
  return handle;
}

function applyNoteSize(el, note) {
  if (note.width)  el.style.width  = `${note.width}px`;
  if (note.height) el.style.height = `${note.height}px`;
}

function createNoteElement(note, onDelete, onPromptRun, onContentChange) {
  const el = document.createElement("div");
  el.className = `note note-${note.type}`;
  el.dataset.id = note.id;
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  applyNoteSize(el, note);

  // response cards are visually attached below their parent via CSS stacking —
  // they don't get a tape strip, just the terminal inner card
  if (note.type === "response") {
    const inner = document.createElement("div");
    inner.className = "note-inner";
    inner.style.height = "100%";

    const header = document.createElement("div");
    header.className = "note-header";
    header.innerHTML = `<span class="note-label">response</span>`;
    inner.appendChild(header);

    const body = document.createElement("div");
    body.className = "note-body";
    const content = document.createElement("div");
    content.className = "response-content" + (note.loading ? " loading" : "");
    content.textContent = note.loading ? "Thinking…" : (note.content || "");
    body.appendChild(content);
    inner.appendChild(body);
    el.appendChild(inner);
    el.appendChild(makeResizeHandle());
    return el;
  }

  // Text + Prompt notes get tape strip (::before) + note-inner wrapper
  const inner = document.createElement("div");
  inner.className = "note-inner";
  inner.style.height = "100%";

  const typeLabel = note.type === "text" ? "text note" : "prompt";

  const header = document.createElement("div");
  header.className = "note-header";
  const labelSpan = document.createElement("span");
  labelSpan.className = "note-label";
  labelSpan.textContent = typeLabel;
  header.appendChild(labelSpan);

  const delBtn = document.createElement("button");
  delBtn.className = "btn-delete";
  delBtn.title = "Delete note";
  delBtn.textContent = "×";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete(note.id);
  });
  header.appendChild(delBtn);
  inner.appendChild(header);

  const body = document.createElement("div");
  body.className = "note-body";
  body.style.flex = "1";
  body.style.overflow = "hidden";

  if (note.type === "text") {
    const ta = document.createElement("textarea");
    ta.placeholder = "Write something…";
    ta.value = note.content || "";
    ta.style.height = "100%";
    ta.addEventListener("input", () => onContentChange(note.id, { content: ta.value }));
    body.appendChild(ta);

  } else if (note.type === "prompt") {
    const ta = document.createElement("textarea");
    ta.placeholder = "Enter a term or concept…";
    ta.value = note.content || "";
    ta.addEventListener("input", () => onContentChange(note.id, { content: ta.value }));

    const sel = document.createElement("select");
    TEMPLATES.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      if (t.id === (note.prompt_template || "explain_term")) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () =>
      onContentChange(note.id, { prompt_template: sel.value })
    );

    const runBtn = document.createElement("button");
    runBtn.className = "btn-run";
    runBtn.textContent = "Run ▶";
    runBtn.addEventListener("click", () => {
      const tpl = TEMPLATES.find((t) => t.id === sel.value) || TEMPLATES[0];
      const builtPrompt = tpl.build(ta.value.trim() || "this concept");
      onPromptRun(note.id, builtPrompt);
    });

    body.appendChild(ta);
    body.appendChild(sel);
    body.appendChild(runBtn);
  }

  inner.appendChild(body);
  el.appendChild(inner);
  el.appendChild(makeResizeHandle());
  return el;
}
