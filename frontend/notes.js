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

// ── Minimal, DOM-safe Markdown renderer ──────────────────────
// LLM answers come back as Markdown; rendering them as plain text showed literal
// **stars** etc. This builds REAL DOM nodes with textContent (never innerHTML),
// so answer text can't inject markup or script even though it's model output —
// the same safety stance as the board-name handling. Supports the subset chat
// answers actually use: headings, bold, italic, inline code, fenced code blocks,
// blockquotes, ordered/unordered lists, links (http/https/mailto only), and
// paragraphs. Returns a DocumentFragment to append into the response card.
function renderMarkdown(src) {
  const root = document.createDocumentFragment();
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    renderInline(para.join(" "), p);
    root.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ``` … ```
    if (/^```/.test(line)) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // consume the closing fence
      const pre = document.createElement("pre");
      const c = document.createElement("code");
      c.textContent = code.join("\n");
      pre.appendChild(c);
      root.appendChild(pre);
      continue;
    }

    // Heading # … ######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const el = document.createElement("h" + h[1].length);
      renderInline(h[2], el);
      root.appendChild(el);
      i++;
      continue;
    }

    // Blockquote (one or more > lines)
    if (/^>\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
      const bq = document.createElement("blockquote");
      renderInline(quote.join(" "), bq);
      root.appendChild(bq);
      continue;
    }

    // Unordered list (-, *, +)
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        renderInline(lines[i].replace(/^\s*[-*+]\s+/, ""), li);
        ul.appendChild(li);
        i++;
      }
      root.appendChild(ul);
      continue;
    }

    // Ordered list (1. 2. …)
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const ol = document.createElement("ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement("li");
        renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""), li);
        ol.appendChild(li);
        i++;
      }
      root.appendChild(ol);
      continue;
    }

    // Blank line → paragraph break
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

    para.push(line);
    i++;
  }
  flushPara();
  return root;
}

// Inline spans: scan left→right, picking the earliest of code / bold / italic /
// link at each step. Code wins ties so * inside `code` isn't parsed. Each token
// becomes an element with textContent (or recursed for nestable styles); plain
// runs become text nodes — so nothing is ever interpreted as HTML.
function renderInline(text, parent) {
  const patterns = [
    { re: /`([^`]+)`/, tag: "code" },
    { re: /\*\*([^*]+)\*\*/, tag: "strong", nest: true },
    { re: /__([^_]+)__/, tag: "strong", nest: true },
    { re: /\*([^*]+)\*/, tag: "em", nest: true },
    { re: /_([^_]+)_/, tag: "em", nest: true },
    { re: /\[([^\]]+)\]\(([^)]+)\)/, tag: "a", link: true },
  ];
  let rest = text;
  let guard = 0;
  while (rest && guard++ < 5000) {
    let best = null;
    for (const p of patterns) {
      const m = p.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { p, m };
    }
    if (!best) { parent.appendChild(document.createTextNode(rest)); break; }
    const { p, m } = best;
    if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
    if (p.link) {
      const a = document.createElement("a");
      const url = (m[2] || "").trim();
      // Only allow safe schemes; an unsafe href is dropped (label still shows).
      if (/^(https?:|mailto:)/i.test(url)) {
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      a.textContent = m[1];
      parent.appendChild(a);
    } else {
      const el = document.createElement(p.tag);
      if (p.nest) renderInline(m[1], el); // bold/italic can contain each other
      else el.textContent = m[1];          // code is literal
      parent.appendChild(el);
    }
    rest = rest.slice(m.index + m[0].length);
  }
}

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
    delBtn.setAttribute("aria-label", "Delete this branch");
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
    // Loading + error states stay plain text (no Markdown surprises); a real
    // answer renders as DOM-built Markdown. `.md` switches the container to
    // normal whitespace so block elements lay out correctly.
    if (note.loading) {
      content.textContent = "Thinking…";
    } else if (!note.content) {
      content.textContent = "";
    } else if (note.content.startsWith("Error:")) {
      content.textContent = note.content;
    } else {
      content.classList.add("md");
      content.appendChild(renderMarkdown(note.content));
    }
    body.appendChild(content);
    inner.appendChild(body);

    // Token counter — make the cost of full-history follow-ups legible. Only shown
    // once a response carries more than a single user+assistant exchange (i.e. it's
    // a follow-up that resent prior history). Estimate ~4 chars per token.
    const convo = note.conversation;
    if (Array.isArray(convo) && convo.length > 2) {
      const chars = convo.reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
      const tokens = Math.round(chars / 4);
      const footer = document.createElement("div");
      footer.className = "token-count";
      footer.textContent = `${convo.length} cards · ~${tokens.toLocaleString()} tokens`;
      inner.appendChild(footer);
    }

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
  delBtn.setAttribute("aria-label", "Delete note");
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
