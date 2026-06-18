# LLM Board — Agent Guide

A spatial **discovery** tool: a freeform canvas where you post notes and prompt an LLM. Think Obsidian Canvas meets a chat interface. The core use case is reading something new, hitting unknown terms, and building a visual map of your understanding as you investigate them.

The soul is **discovery / thinking / figuring things out — not memorization.** Design choices favour *following your curiosity deeper* (the rabbit-hole) over storing/reviewing what you already know. (Detailed positioning + the evidence behind it lives in `docs/ROADMAP.md`, which is gitignored/local.)

The interface is a **horizontal, zoomable thought-tree forest**: a prompt's answer appears to its right, each answer carries floating **orbit moves** that fork the thread rightward, and tangents **break out** into their own trees. EPIC #21 (PRs #27–#32) replaced the old vertical-chain / scroll-canvas model; the section [The horizontal thought-tree](#the-horizontal-thought-tree) below is the authoritative description of how it works.

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
│   ├── canvas.js     # State, camera/zoom, tree render + tidy layout, drag, orbit moves, detach, undo, focus
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
| `prompt` | Textarea + Run button + Bloom's `TEMPLATES` selector. **Only a ROOT prompt renders as a card** — its answer appears to the right. A follow-up prompt (created by an explore move) is **hidden**: it carries the move + context in the data, but the orbit move pill is the visible "question", so the answer connects straight through it. |
| `response` | LLM output, read-only, with a delete `×`. Its explore moves are **floating orbit pills to the right** (not a footer); clicking one forks a child branch. |

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
  "prompt_template": "explain_term",   // root prompt → a TEMPLATES id; forked follow-up → an EXPLORE_MOVES id; null for "ask your own"
  "parent_id": "uuid or null",
  "thread_id": "uuid or null",
  "is_root": true,                     // optional — a detached / broken-out forest root
  "origin_id": "uuid",                 // optional — break-out only: source response (drives the dashed origin link)
  "conversation_context": [{"role": "user|assistant", "content": "..."}],
  "conversation": [{"role": "user|assistant", "content": "..."}]
}
```

`x`/`y` are the note's **stored** position — set once when created, on drag, or by Tidy; the renderer paints them, it does not recompute layout. The board JSON also carries top-level `"layout": "tree"` (migration stamp) and `"pill_pos"` (`{"responseId:moveId": {x, y}}` for dragged orbit pills). All of these are freeform keys the backend round-trips untouched (`layout`/`pill_pos` are declared optional on `BoardData` so Pydantic doesn't drop the board-level fields).

### Conversation threads (the tree)

A thread is a tree: `root prompt → response → [orbit move] → response → [orbit move] → response → …`, growing rightward. A response can fork into **many** children.

- Every node links to its parent via `parent_id`; nodes in a thread share a `thread_id`. A forest **root** is any note with `parent_id == null` (a typed root prompt, a standalone text note, or a detached/broken-out node).
- **Hidden follow-up prompts:** a fork creates `response → hidden prompt (carries move_id + context) → response`. The hidden prompt renders no card; `displayChildrenOf()` treats it as a pass-through so the source response connects directly to the forked response, with the wire routed through the orbit pill.
- Full conversation history is passed to the LLM on every follow-up (no windowing). `buildHistory()` walks `parent_id` upward — unaffected by multi-child forking.

### Rendering

`renderAll()` in `canvas.js` clears and **paints from stored positions** — it does not run the layout. For each visible note it places the card at `note.x/note.y`, then builds the orbit pills and draws the SVG wires. Hidden follow-up prompts are skipped. Positions only change via `placeNewNode()` (once, at creation), a drag, or `tidyTree()` (the manual ✦ Tidy button). This "paint, don't recompute" rule is what keeps the canvas calm — moving one node never reflows the rest.

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

### Explore moves (the headline — "fork a thread")
Each **response** has a column of floating **orbit pills** to its right (built in `canvas.js`, not in the card). Clicking one **forks a child branch** rightward in one step. Defined in `EXPLORE_MOVES` in `notes.js` (`{id, label, needsInput, build(input)}`), grounded in the Graesser question taxonomy / Aristotle's *topoi*:

- `more` *Tell me more* · `why` *Why?* · `example` *Give an example* — one click, no input.
- `relate` *Relate / compare…* · `term` *Explain a term…* — `needsInput: true`; clicking reveals a tiny inline `<input>` (Enter submits, Esc cancels).
- `↗ new tree` — break out a term into a fresh standalone tree (see Detach below).
- `↩ ask your own` — free-text follow-up (`replyToResponse`), the escape hatch so moves scaffold without caging the user's own questions.

`exploreFromResponse(responseId, move, inputText)` creates a follow-up prompt (`prompt_template = move.id`, hidden) and runs it — many forks per response allowed. A spent move dims but stays clickable (re-fork). Pills are freely draggable (pinned in `pillPos`). **To add a move:** add an entry to `EXPLORE_MOVES`; no other changes needed.

### Soft-delete + undo
Deleting a note (and its whole chain subtree) is reversible via a 10-level LIFO `undoStack` in `canvas.js`, surfaced as an undo affordance in the toolbar. **No auto-expiry timeout** — a countdown to permanent loss is hostile to the ND audience; undo stays until the stack drains or the page reloads.

### Focus / dim-the-rest mode
A toolbar `#btn-focus` toggle (`focusMode` / `activeGroupId` in `canvas.js`) dims every **tree** except the active one; click a tree to make it active. Grouping is by forest root (`rootOf(id)`). **View-only / derived** — never persisted to board JSON, cleared on reload. Applied via `.dimmed` inside `renderAll`. Dimmed cards stay click-selectable; their internal controls are JS-guarded.

### Drag, tidy, detach
- **Drag** any card by its header to reposition it freely — it stays where you drop it and **nothing else moves** (wires + the card's pills track live). Stored on `note.x/note.y`.
- **✦ Tidy** (toolbar) is the only thing that re-arranges: `tidyTree()` runs the tidy-tree layout and **glides** cards into place with a slow soft ease, never a snap.
- **Detach** (`detachToRoot`) promotes a node + subtree to a standalone root: **break-out** (from a term — text-selection bubble or `↗ new tree` move — keeps a dashed origin link) or **unlink** (long-press a card header ~400ms → lift → release; no link, context-before dropped).

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

**Now in force from EPIC #21 (the current model — preserve these):**
- **Transform camera** — `#canvas` is a zoomable world (`transform: translate+scale`), not a fixed scroll div. Pan via left-drag on empty space / middle-button / plain-wheel; zoom via corner `+/−/FIT`, `Ctrl/⌘+wheel` toward cursor, keys `+/−/0`. Camera pan/zoom is view-only, never persisted.
- **Stored positions, painted not recomputed** — `renderAll` paints `note.x/note.y`; layout only runs in `placeNewNode` (create), drag, or `tidyTree`. Do not reintroduce per-render auto-layout (it caused the "everything jumps" motion).
- **Free multi-child forking** — a response can have many children; there is no one-follow-up guard.
- **SVG wires** (not `.note-connector` divs) connect nodes; hidden follow-up prompts route their wire through the orbit pill; break-out roots get a dashed teal `wire-origin`.

---

## Known limitations / planned future work

- **No multi-board UI** — the board name is hardcoded to `"default"` in `canvas.js`. The backend already supports named boards via `GET/POST /board/:name`; a board switcher in the toolbar just needs frontend wiring. (Under the tree model: a board is a *forest* of rabbit-holes; the switcher is "multiple forests.")
- **Keyboard-first interaction (#12)** — still open: visible focus rings + key shortcuts. Pairs naturally with the tree (arrow keys to walk it, number keys to fire orbit moves).
- **Smarter new-node placement** — `placeNewNode` finds a spot once and never re-tidies, so dense forking can produce overlap until you press ✦ Tidy. A height-aware / clear-slot placement would reduce manual tidying.
- **Explore moves are a fixed set** — LLM-generated *contextual* suggestions (Perplexity-style, derived from the answer) are a deferred next step. Root-prompt moves aren't unified with the follow-up set yet.
- **Token counter** — planned: a small label on response cards showing e.g. `4 cards · ~3,200 tokens`.
- **Chain summarization** — deprioritized: a user-triggered "Collapse into summary card" for very long branches.
- **Understanding markers / spaced review** — *demoted to optional*. The tool's soul is discovery, not memorization; markers would be an opt-in retention add-on, not a headline.

---

## The horizontal thought-tree

**Shipped as EPIC #21 (PRs #27–#32).** This is the live model. `/mockups/` (`F-tidy-tree-autostack.html` = layout + camera; `G-breakout-multitree.html` = break-out + multi-tree) remain as the design reference the implementation followed.

### How it works
A prompt's answer appears **to the right**; a thread grows rightward into a tree.

- **Orbit moves** — floating pills to the right of each response (`buildOrbits`). One click **forks a child branch** (`exploreFromResponse`); a spent move dims but re-forks. Pills are freely draggable (`pillPos`) and sit a roomy `ORBIT_GAP` out so the tethers read.
- **Free multi-child forking** — a response can spawn many children; no one-follow-up guard.
- **Camera** — `#canvas` is a `transform: translate+scale` world: `zoomAt`/`fitAll`, pan via left-drag-empty / middle-button / plain-wheel, zoom via `Ctrl/⌘+wheel` + corner buttons + keys. View-only.
- **Stable layout** — positions are **stored** on each note and only set at creation (`placeNewNode`, non-overlapping spot, nothing else moves), on drag, or by **✦ Tidy** (`tidyTree` → `computeForest` then a slow gliding ease). The tidy-tree maths (`countLeaves`/`assignLayout`/`computeForest`) run *only* inside `tidyTree`, never per-render.
- **SVG wires** — `prompt→response` / forked-`response→response` (routed through the orbit pill) are strong; `response→orbit` tethers thin; break-out origins dashed teal. Redrawn live during a drag (`redrawWiresLive`).

### Detach — break-out & unlink (one operation, two entry points)
`detachToRoot(nodeId, {originId})` promotes a node **+ its whole subtree** to a forest **root** (`is_root: true`, `parent_id: null`).
- **Break-out** — a *term* from an answer (text-selection bubble or `↗ new tree` orbit move) → a **fresh** root (no carried `conversation_context`) with `origin_id` → a dashed origin link. `breakOutTerm()`.
- **Unlink** — long-press a card header ~400ms → lift → release. Promotes the existing node+subtree, **no link**, and clears `conversation_context` across the whole subtree (context-before dropped).

### Hidden follow-up prompts & data keys
A fork is stored as `response → hidden prompt → response`. The hidden prompt (a prompt with a `parent_id`) renders no card; `displayChildrenOf()` passes through it so the source response connects straight to the forked response. The forked prompt keeps `prompt_template = move.id` (NOT a separate `move_id` field — `buildHistory` reads `prompt_template`, so this avoided a migration). Board-level `layout: "tree"` (migration stamp) and `pill_pos` are declared optional on `BoardData`; legacy boards run `tidyTree()` once on load to convert stored vertical coords to the horizontal layout.
