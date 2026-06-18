# LLM Board — Agent Guide

A spatial **discovery** tool: a freeform canvas where you post notes and prompt an LLM. Think Obsidian Canvas meets a chat interface. The core use case is reading something new, hitting unknown terms, and building a visual map of your understanding as you investigate them.

The soul is **discovery / thinking / figuring things out — not memorization.** Design choices favour *following your curiosity deeper* (the rabbit-hole) over storing/reviewing what you already know. (Detailed positioning + the evidence behind it lives in `docs/ROADMAP.md`, which is gitignored/local.)

> ⚠️ **Spatial model is mid-migration (EPIC #21).** The code on `main` today is the **vertical-chain** model documented below (`prompt → response → follow-up`, stacked downward, fixed scroll-canvas). It is being **replaced one-way** by a **horizontal, auto-laid-out, zoomable thought-tree forest** — see [The horizontal thought-tree (the new model — in progress)](#the-horizontal-thought-tree-the-new-model--in-progress) at the bottom. When working on tree slices (#22–#26), that section is the target; the sections in between describe what currently exists and what each slice supersedes. Don't assume the tree exists in the code until its slice has merged.

---

## Running the project

```bash
# From the project root
pip install -r requirements.txt

# Copy the example config and add your API key
cp config.yaml.example config.yaml
# Edit config.yaml and set your API key

cd backend
uvicorn main:app --reload
# Open http://localhost:8000
```

---

## Project structure

```
LLM_Board/
├── backend/
│   ├── main.py       # FastAPI server — /board/:name, /prompt
│   ├── llm.py        # LLM provider abstraction (Mistral, Groq, Gemini)
│   ├── storage.py    # Load/save board JSON to disk
│   └── config.py     # Reads config.yaml
├── frontend/
│   ├── index.html    # Shell — toolbar + canvas container
│   ├── canvas.js     # State, rendering, drag, resize, chain logic, undo, focus mode, explore
│   ├── notes.js      # Note card DOM construction; TEMPLATES (root) + EXPLORE_MOVES (follow-up)
│   └── style.css     # Paper/parchment visual theme
├── boards/           # Saved board JSON files (auto-created)
└── config.yaml       # LLM provider + API key
```

---

## Architecture

### Note types

| Type | Description |
|---|---|
| `text` | Plain freeform note. No LLM interaction. Draggable, resizable. |
| `prompt` | Textarea + Run button. A **root** prompt shows the Bloom's `TEMPLATES` selector; a **follow-up** prompt (created by an explore move) is generated, not hand-authored. Spawns a response note below. |
| `response` | LLM output, read-only. Footer carries one-click **explore moves** + a free-text "↩ ask your own" to continue the thread. |

### Data model

Each note in `boards/*.json`:

```json
{
  "id": "uuid",
  "type": "text|prompt|response",
  "x": 120,
  "y": 340,
  "width": 290,
  "height": null,
  "content": "...",
  "prompt_template": "explain_term",   // root prompt → a TEMPLATES id; follow-up → an EXPLORE_MOVES id
  "parent_id": "uuid or null",
  "thread_id": "uuid or null",
  "conversation_context": [{"role": "user|assistant", "content": "..."}],
  "conversation": [{"role": "user|assistant", "content": "..."}]
}
```

### Conversation chains (current vertical model — being replaced by the tree, EPIC #21)

A chain is: `prompt → response → follow-up prompt → response → ...`

- All notes in a chain share a `thread_id`
- Each node links to the one above it via `parent_id`
- `renderChain()` in `canvas.js` walks `parent_id` links downward to build the chain group div — **assumes a single child per node** (`notes.find(n => n.parent_id === current.id)`). This single-child walk is exactly what slice #23 replaces with a multi-child tidy-tree layout.
- The entire chain is draggable from the root prompt header
- Full conversation history is passed to the LLM on every follow-up (no windowing)

### Rendering

`renderAll()` in `canvas.js` clears and redraws everything:
- `text` notes → rendered standalone via `makeDraggable()`
- `prompt` notes that are chain roots → rendered via `renderChain()`
- `response` notes → **never rendered standalone**, always part of their chain group

### LLM calls

`POST /prompt` accepts:
```json
{ "messages": [{"role": "user|assistant", "content": "..."}] }
```
or the legacy form:
```json
{ "prompt": "string" }
```

The frontend always sends `messages`. The backend wraps a bare `prompt` into a single-message array before passing to the provider.

---

## Interaction features

### Explore moves (the headline — "deepen a thread")
Each **response** card's footer shows a row of one-click **explore moves** that spawn the next answer in the thread in a single step (no separate compose). Defined in `EXPLORE_MOVES` in `notes.js` (`{id, label, needsInput, build(input)}`), grounded in the Graesser question taxonomy / Aristotle's *topoi*:

- `more` *Tell me more* · `why` *Why?* · `example` *Give an example* — one click, no input.
- `relate` *Relate / compare…* · `term` *Explain a term…* — `needsInput: true`; clicking reveals a tiny inline `<input>` (Enter submits, Esc cancels) for a second term.
- Plus **↩ ask your own** — the existing free-text follow-up (`replyToResponse`), kept as an escape hatch so moves scaffold without caging the user's own questions.

`exploreFromResponse(responseId, move, inputText)` in `canvas.js` builds history, creates/replaces the follow-up prompt node (`prompt_template = move.id`), and runs it in one shot. `buildHistory` reconstructs explore-move turns (branch on `EXPLORE_MOVES` for follow-ups) so multi-step rabbit-holes keep accurate context. **To add a move:** add an entry to `EXPLORE_MOVES`; no other changes needed.

### Soft-delete + undo
Deleting a note (and its whole chain subtree) is reversible via a 10-level LIFO `undoStack` in `canvas.js`, surfaced as an undo affordance in the toolbar. **No auto-expiry timeout** — a countdown to permanent loss is hostile to the ND audience; undo stays until the stack drains or the page reloads.

### Focus / dim-the-rest mode
A toolbar `#btn-focus` toggle (`focusMode` / `activeGroupId` in `canvas.js`) dims every top-level group except the active one; click a group to make it active. **View-only / derived** — never persisted to board JSON, cleared on reload. Applied via `.dimmed` inside `renderAll`. Dimmed cards stay click-selectable (so click-to-focus works); their internal controls are JS-guarded.

---

## Bloom's Taxonomy templates (root prompts only)

Defined in `frontend/notes.js` → `TEMPLATES` array. Each template:

```js
{
  id: "break_it_down",
  bloom: "analyze",          // remember | understand | apply | analyze | evaluate
  label: "Break it into parts",
  build: (input) => `Break "${input}" into its key components...`
}
```

**Scope:** templates apply to **root** prompts only. On **follow-ups**, Bloom's is superseded by the evidence-backed `EXPLORE_MOVES` (see Interaction features) — adversarial research found Bloom's-as-prompting-scaffold weakly supported, so it's treated as a UI heuristic for opening a topic, not a cognitive ladder.

The root prompt note header renders a badge (`symbol + level`) and gets a subtle background tint based on the selected template's Bloom's level. Both update live when the user changes the template dropdown.

| Level | Symbol | Tint |
|---|---|---|
| remember | ◉ | default |
| understand | ◎ | blue-grey |
| apply | ▶ | amber |
| analyze | ⊞ | teal |
| evaluate | ⊙ | violet |

To add a template: add an entry to `TEMPLATES` in `notes.js`. No other changes needed.

---

## LLM provider config

`config.yaml` selects the active provider:

```yaml
provider: mistral   # or groq, gemini

mistral:
  api_key: YOUR_KEY
  model: mistral-small-latest
```

To add a new provider:
1. Add a key block in `config.yaml`
2. Add a class extending `LLMProvider` in `backend/llm.py` — implement `complete(messages: list[dict]) -> str`
3. Add a case in `get_provider()` in `backend/llm.py`

---

## Design decisions to preserve

**Still in force (do not change):**
- **Paper/parchment aesthetic** — warm cream background (`#f4ecd8`), serif (Lora) + monospace (Source Code Pro) type mix, translucent tape strips on cards, hard 3px offset shadows (not blurs), dark terminal-style response cards. Do not introduce heavy border-radius, material design, or dark-mode-first patterns. (Survives the tree migration — the tree restyles *layout*, not the card visual language.)
- **Vanilla JS, no framework** — no React, no build step, no bundler. `index.html` loads `notes.js` then `canvas.js` directly. Keep it that way unless there is a strong reason to change.
- **Full conversation history** — sent in full on every follow-up. At 3–6 turns this costs fractions of a cent. Do not add windowing complexity unless chains regularly exceed ~15 turns. (`buildHistory` is per-node-to-root, so it survives the tree change unchanged.)
- **`renderAll()` is the single source of truth** — when state changes, call `renderAll()`. Do not try to do partial DOM updates; the canvas is wiped and redrawn each time. (Undo, focus mode, and explore moves all route through it. The tree layout pass also runs inside `renderAll`.)
- **Discovery, not memorization** — favour features that help the user *follow curiosity deeper* (explore moves, the rabbit-hole, break-out tangents) over retention/review machinery. A spaced-repetition "understanding markers" loop was explicitly demoted to optional. Don't reintroduce it as a headline.
- **View state stays out of board JSON** — `focusMode`/`activeGroupId` and the `undoStack` are in-memory only; never persist them. Only the `notes` array (and `layout`) is saved. (The camera's pan/zoom is also view-only — never persist it.)

**OVERRULED by EPIC #21 (do NOT preserve these — they're being removed):**
- ~~**Canvas is a large fixed div** — 4000×3000px with `overflow: scroll`.~~ → Replaced by a **transform-based camera** (`translate+scale` on a `#world` layer): a true zoomable infinite space (slice #22).
- ~~**MMB to pan** via `scrollLeft`/`scrollTop`.~~ → Replaced by **drag-to-pan + zoom** (corner `+/−/FIT`, `Ctrl/⌘+wheel` toward cursor, keys `+/−/0`); zoom was issue #10, formerly wontfix, now core.
- ~~**Vertical `renderChain`** (single child walked downward).~~ → Replaced by the **tidy-tree forest layout** (multi-child, siblings auto-stack, never overlap; slice #23). The `.note-connector` CSS gives way to SVG wires.
- ~~**One follow-up per response** (`alreadyHasFollowUp` guard).~~ → Removed so a response can **fork freely** into many branches (slice #24).

---

## Known limitations / planned future work

- **Horizontal thought-tree (EPIC #21)** — the active major work; see the section below. Supersedes the vertical chain, the scroll-canvas, and zoom (#10).
- **No multi-board UI** — the board name is hardcoded to `"default"` in `canvas.js`. The backend already supports named boards via `GET/POST /board/:name`; a board switcher in the toolbar just needs frontend wiring. (Reframed under the tree model as "a board is a *forest* of rabbit-holes"; the switcher is then "multiple forests.")
- **Explore moves are a fixed set** — LLM-generated *contextual* suggestions (Perplexity-style, derived from the answer) are a deferred next step. Root-prompt moves aren't unified with the follow-up set yet.
- **Keyboard-first interaction** — visible focus rings + key shortcuts (`n`/`Enter`/`Esc`/`Del`) are the remaining ND-credibility-basics item (#12). Pairs naturally with the tree (arrow keys to walk it, number keys to fire orbit moves).
- **Token counter** — planned: a small label on response cards showing e.g. `4 cards · ~3,200 tokens`.
- **Chain summarization** — deprioritized: a user-triggered "Collapse into summary card" for very long branches.
- **Understanding markers / spaced review** — *demoted to optional*. The tool's soul is discovery, not memorization; markers would be an opt-in retention add-on, not a headline.

---

## The horizontal thought-tree (the new model — in progress)

**Status: planned/in-progress as EPIC #21 (slices #22–#26). NOT yet on `main`.** Prototyped end-to-end in `/mockups/` (`F-tidy-tree-autostack.html` = layout + camera; `G-breakout-multitree.html` = break-out + multi-tree) — those files are the reference implementation. The full sequenced plan lives in the plan file; this is the orientation for an agent picking up a slice.

### What it replaces the vertical chain with
A prompt's answer appears **to the right** (timeline feel), and a thread grows into a **tree** that the app lays out automatically:

- **Orbit moves.** Each response's explore moves are **floating nodes to its right** (not a footer row). One click **forks a child branch rightward** in one shot. The clicked move tucks to a dim "spent" waypoint but stays clickable (re-fork later); the others remain.
- **Free forking.** A response can spawn *many* children — the thread is a tree, not a line. (The `alreadyHasFollowUp` guard is removed.)
- **Tidy-tree auto-stack.** Each node reserves vertical space sized to its **whole subtree** (`countLeaves` → `assign` → `layoutForest`), so forking siblings push apart and **never overlap**. On each fork, all nodes **glide** to new positions (CSS `transition` on `left`/`top`). The move-orbit counts as pseudo-leaves so an un-forked response still reserves room for its buttons.
- **Camera (zoomable infinite space).** A `#world` layer with `transform: translate+scale` replaces the fixed scroll-canvas. Manual zoom: corner `+/−/FIT`, `Ctrl/⌘+wheel` toward cursor, keys `+/−/0`; drag empty space to pan. **Calm camera** — no auto-follow; only a gentle nudge if a new node would land off-screen.
- **SVG wires** connect parent→child (replacing `.note-connector`): `prompt→response` and `spent-move→child` strong; `response→orbit-move` thin; **dashed teal** for break-out origin links.

### Detach — break-out & unlink (one operation, two entry points)
`detachToRoot(nodeId, {originId})` promotes a node **+ its whole subtree** to a forest **root** (`is_root: true`, `parent_id: null`). Multiple trees coexist on one board, each in its own vertical band.
- **Break-out** — chase a *term* out of an answer (text-selection bubble, an `↗ new tree` orbit move, or drag-a-move-to-empty-canvas). Creates a **fresh** root (no carried `conversation_context`) with `origin_id = sourceResponseId` → a **faint dashed origin link** back to the source.
- **Unlink** — promote an *existing* node+subtree to a root: **fully standalone, no link**, with `conversation_context` cleared (context-before is dropped). Same op, just no `origin_id`.

### Data model (frontend-only additions — backend stays opaque)
Reuses the flat `notes[]` + `parent_id`/`thread_id`. New freeform keys (round-trip safe — `notes` is an untyped list the backend never inspects):
- `move_id` — which `EXPLORE_MOVES` id forked this follow-up (replaces the explore-move use of `prompt_template`).
- `is_root: true` — marks a detached/break-out forest root.
- `origin_id` — break-out only: source response id (drives the dashed link). Absent for unlink.
- `layout: "tree"` on the board — stamps a board as migrated.

**Migration:** old vertical boards are migrated **on load** (`loadBoard`). Vertical chains are already linear trees, so migration just stamps `layout: "tree"` and re-saves — the new renderer lays the existing chains out horizontally with no structural rewrite.
