const BLOOM_LEVELS = {
  remember:   { symbol: "◉", label: "remember",   tint: "#f0e8cc" },
  understand: { symbol: "◎", label: "understand",  tint: "#dde8f0" },
  apply:      { symbol: "▶", label: "apply",       tint: "#f5edda" },
  analyze:    { symbol: "⊞", label: "analyze",     tint: "#daeee8" },
  evaluate:   { symbol: "⊙", label: "evaluate",    tint: "#eae4f2" },
};

const TEMPLATES = [
  // Remember
  { id: "define_concept",        bloom: "remember",   label: "Define concept",          build: (i) => `Give a concise, clear definition of "${i}".` },
  // Understand
  { id: "explain_term",          bloom: "understand",  label: "Explain term",            build: (i) => `Explain the term "${i}" in simple language. Be concise.` },
  { id: "eli5",                  bloom: "understand",  label: "Explain like I'm 5",      build: (i) => `Explain "${i}" like I'm 5 years old.` },
  { id: "five_levels",           bloom: "understand",  label: "5 levels of depth",       build: (i) => `Explain "${i}" at 5 levels:\n1. Child\n2. Teenager\n3. College student\n4. Graduate student\n5. Domain expert\nUse a separate paragraph for each.` },
  // Apply
  { id: "give_example",          bloom: "apply",       label: "Give me an example",      build: (i) => `Give me a concrete, real example of "${i}" in action.` },
  { id: "real_world",            bloom: "apply",       label: "Real-world use case",     build: (i) => `Describe a real-world scenario where "${i}" is used. Be specific.` },
  // Analyze
  { id: "break_it_down",         bloom: "analyze",     label: "Break it into parts",     build: (i) => `Break "${i}" into its key components or parts and explain each briefly.` },
  { id: "compare_contrast",      bloom: "analyze",     label: "Compare & contrast",      build: (i) => `Compare and contrast "${i}" with a closely related concept. What makes them similar and different?` },
  { id: "relate_to",             bloom: "analyze",     label: "How does it relate?",     build: (i) => `How does "${i}" relate to other concepts in its field? Give 2–3 connections.` },
  // Evaluate
  { id: "when_use",              bloom: "evaluate",    label: "When to use vs. not use", build: (i) => `When should you use "${i}" and when should you avoid it? Give clear criteria.` },
  { id: "test_my_understanding", bloom: "evaluate",    label: "Test my understanding",   build: (i) => `I think I understand "${i}". Ask me 2–3 short questions to test whether I really do, then tell me what I should focus on.` },
];

// Explore moves — one-click next steps shown on each response card. Grounded in the
// Graesser question taxonomy + Aristotle's topoi: feature-specification, causal,
// example, comparison/relationship, concept-completion (the rabbit-hole jump). The
// chain history already travels via conversation_context, so "this" needs no antecedent.
// needsInput moves reveal a tiny inline field (a second term) before sending.
const EXPLORE_MOVES = [
  { id: "more",    label: "Tell me more",     needsInput: false, build: ()  => `Tell me more about this — add detail and important properties not yet covered.` },
  { id: "why",     label: "Why?",             needsInput: false, build: ()  => `Why is this so? Explain the underlying reason or mechanism.` },
  { id: "example", label: "Give an example",  needsInput: false, build: ()  => `Give a concrete, real example of this in action.` },
  { id: "relate",  label: "Relate / compare…", needsInput: true,  inputPlaceholder: "to what?",   build: (i) => `How does this relate to and compare with ${i}? Cover what's similar and what's different.` },
  { id: "term",    label: "Explain a term…",   needsInput: true,  inputPlaceholder: "which term?", build: (i) => `Explain the term "${i}" as it was used above — define it simply and say how it connects to what we were discussing.` },
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

function getBloomForTemplate(templateId) {
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  return tpl ? BLOOM_LEVELS[tpl.bloom] : BLOOM_LEVELS.remember;
}

function createNoteElement(note, onDelete, onPromptRun, onContentChange, onReply, onExplore) {
  const el = document.createElement("div");
  el.className = `note note-${note.type}`;
  el.dataset.id = note.id;
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  applyNoteSize(el, note);

  // ── Response card ──────────────────────────────────────────
  if (note.type === "response") {
    const inner = document.createElement("div");
    inner.className = "note-inner";
    inner.style.height = "100%";

    const header = document.createElement("div");
    header.className = "note-header";
    header.innerHTML = `<span class="note-label">response</span>`;
    // Delete this branch. (Response cards carry the only delete affordance for a
    // forked branch now that the follow-up prompt card is hidden.)
    const delBtn = document.createElement("button");
    delBtn.className = "btn-delete";
    delBtn.title = "Delete this branch";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete(note.id);
    });
    header.appendChild(delBtn);
    inner.appendChild(header);

    const body = document.createElement("div");
    body.className = "note-body";
    const content = document.createElement("div");
    content.className = "response-content" + (note.loading ? " loading" : "");
    content.textContent = note.loading ? "Thinking…" : (note.content || "");
    body.appendChild(content);
    inner.appendChild(body);

    // Explore moves no longer live in a footer — they render as floating orbit
    // nodes to the right of the card (built in canvas.js renderAll). onExplore /
    // onReply are wired from there.
    el.appendChild(inner);
    el.appendChild(makeResizeHandle());
    return el;
  }

  // ── Text + Prompt cards ────────────────────────────────────
  const inner = document.createElement("div");
  inner.className = "note-inner";
  inner.style.height = "100%";

  const bloom = getBloomForTemplate(note.prompt_template || "explain_term");

  const header = document.createElement("div");
  header.className = "note-header";
  if (note.type === "prompt") {
    header.style.background = bloom.tint;
  }

  const labelSpan = document.createElement("span");
  labelSpan.className = "note-label";
  labelSpan.textContent = note.type === "text" ? "text note" : "prompt";
  header.appendChild(labelSpan);

  if (note.type === "prompt") {
    const badge = document.createElement("span");
    badge.className = "bloom-badge";
    badge.textContent = `${bloom.symbol} ${bloom.label}`;
    header.appendChild(badge);
  }

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
      const lvl = BLOOM_LEVELS[t.bloom];
      opt.textContent = `${lvl.symbol}  ${t.label}`;
      if (t.id === (note.prompt_template || "explain_term")) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.addEventListener("change", () => {
      onContentChange(note.id, { prompt_template: sel.value });
      // Update header tint + badge live
      const newBloom = getBloomForTemplate(sel.value);
      header.style.background = newBloom.tint;
      const existingBadge = header.querySelector(".bloom-badge");
      if (existingBadge) existingBadge.textContent = `${newBloom.symbol} ${newBloom.label}`;
    });

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
