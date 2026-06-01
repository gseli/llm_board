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

// Deepen moves — shown on FOLLOW-UP prompts (a prompt whose parent is a response).
// These are evidence-backed depth scaffolds (self-explanation g≈0.55, elaborative
// interrogation d≈0.56, curiosity/knowledge-gap), not Bloom's levels. The follow-up
// is where depth happens in Socratic dialogue; the root prompt keeps the term-framing
// TEMPLATES. `build(input)` takes the user's optional "specific angle" text; an empty
// input still yields a sensible prompt because the full chain history travels with it.
const DEEPEN_MOVES = [
  { id: "why",        label: "Why is this so?",            build: (i) => i ? `Why is this true, specifically regarding ${i}? Explain the underlying reason or mechanism.` : `Why is this true? Explain the underlying reason or mechanism, not just the what.` },
  { id: "explain_back", label: "Let me explain it back",    build: (i) => i ? `Here is my own explanation: "${i}". Check it — what did I get right, and where am I fuzzy or wrong?` : `I'll explain this back in my own words so you can check my understanding. Ask me to explain the key idea, then tell me where I'm fuzzy or wrong.` },
  { id: "gap",        label: "What don't I understand yet?", build: (i) => i ? `Given what we've covered and my focus on ${i}, what important gaps remain in my understanding? Name 2–3 things I haven't grasped yet and why they matter.` : `What important gaps remain in my understanding of this so far? Name 2–3 things I haven't grasped yet and why they matter.` },
  { id: "deeper",     label: "One layer deeper",           build: (i) => i ? `Go one layer deeper on ${i}: the mechanism or detail beneath what we just covered.` : `Go one layer deeper than the explanation so far — the mechanism or detail beneath it.` },
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

function createNoteElement(note, onDelete, onPromptRun, onContentChange, onReply) {
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
    inner.appendChild(header);

    const body = document.createElement("div");
    body.className = "note-body";
    const content = document.createElement("div");
    content.className = "response-content" + (note.loading ? " loading" : "");
    content.textContent = note.loading ? "Thinking…" : (note.content || "");
    body.appendChild(content);
    inner.appendChild(body);

    // Reply footer
    const footer = document.createElement("div");
    footer.className = "note-footer";
    const replyBtn = document.createElement("button");
    replyBtn.className = "btn-reply";
    replyBtn.textContent = "↩ follow up";
    replyBtn.disabled = !!note.loading;
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (onReply) onReply(note.id);
    });
    footer.appendChild(replyBtn);
    inner.appendChild(footer);

    el.appendChild(inner);
    el.appendChild(makeResizeHandle());
    return el;
  }

  // ── Text + Prompt cards ────────────────────────────────────
  const inner = document.createElement("div");
  inner.className = "note-inner";
  inner.style.height = "100%";

  // A prompt whose parent is a response is a FOLLOW-UP → deepen-move UI, not Bloom's.
  const isFollowUp = note.type === "prompt" && !!note.parent_id;
  const bloom = getBloomForTemplate(note.prompt_template || "explain_term");

  const header = document.createElement("div");
  header.className = "note-header";
  if (note.type === "prompt" && !isFollowUp) {
    header.style.background = bloom.tint;
  }

  const labelSpan = document.createElement("span");
  labelSpan.className = "note-label";
  labelSpan.textContent = note.type === "text" ? "text note" : isFollowUp ? "deepen" : "prompt";
  header.appendChild(labelSpan);

  if (note.type === "prompt" && !isFollowUp) {
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

  } else if (note.type === "prompt" && isFollowUp) {
    // Follow-up: choose a deepen move; the textarea is an OPTIONAL specific angle.
    const ta = document.createElement("textarea");
    ta.placeholder = "Anything specific? (optional)";
    ta.value = note.content || "";
    ta.addEventListener("input", () => onContentChange(note.id, { content: ta.value }));

    const sel = document.createElement("select");
    DEEPEN_MOVES.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === (note.prompt_template || DEEPEN_MOVES[0].id)) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => onContentChange(note.id, { prompt_template: sel.value }));

    const runBtn = document.createElement("button");
    runBtn.className = "btn-run";
    runBtn.textContent = "Deepen ▶";
    runBtn.addEventListener("click", () => {
      const move = DEEPEN_MOVES.find((m) => m.id === sel.value) || DEEPEN_MOVES[0];
      onPromptRun(note.id, move.build(ta.value.trim()));
    });

    body.appendChild(ta);
    body.appendChild(sel);
    body.appendChild(runBtn);

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
