# LLM Board — Agent Guide

A spatial **discovery** tool: a freeform canvas where you post notes and prompt an LLM. Think Obsidian Canvas meets a chat interface. The core use case is reading something new, hitting unknown terms, and building a visual map of your understanding as you investigate them.

The soul is **discovery / thinking / figuring things out — not memorization.** Design choices favour *following your curiosity deeper* (the rabbit-hole) over storing/reviewing what you already know. (Detailed positioning + the evidence behind it lives in `docs/ROADMAP.md`, which is gitignored/local.)

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

### Conversation chains

A chain is: `prompt → response → follow-up prompt → response → ...`

- All notes in a chain share a `thread_id`
- Each node links to the one above it via `parent_id`
- `renderChain()` in `canvas.js` walks `parent_id` links downward to build the chain group div
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

- **Paper/parchment aesthetic** — warm cream background (`#f4ecd8`), serif (Lora) + monospace (Source Code Pro) type mix, translucent tape strips on cards, hard 3px offset shadows (not blurs), dark terminal-style response cards. Do not introduce heavy border-radius, material design, or dark-mode-first patterns.
- **Vanilla JS, no framework** — no React, no build step, no bundler. `index.html` loads `notes.js` then `canvas.js` directly. Keep it that way unless there is a strong reason to change.
- **Full conversation history** — sent in full on every follow-up. At 3–6 turns this costs fractions of a cent. Do not add windowing complexity unless chains regularly exceed ~15 turns.
- **Canvas is a large fixed div** — 4000×3000px with `overflow: scroll` on the container. Not a CSS transform-based virtual canvas. Sufficient for personal use.
- **MMB to pan** — middle mouse button drag pans the canvas via `scrollLeft`/`scrollTop`.
- **`renderAll()` is the single source of truth** — when state changes, call `renderAll()`. Do not try to do partial DOM updates; the canvas is wiped and redrawn each time. (Undo, focus mode, and explore moves all route through it.)
- **Discovery, not memorization** — favour features that help the user *follow curiosity deeper* (explore moves, the rabbit-hole) over retention/review machinery. A spaced-repetition "understanding markers" loop was explicitly demoted to optional. Don't reintroduce it as a headline.
- **View state stays out of board JSON** — `focusMode`/`activeGroupId` and the `undoStack` are in-memory only; never persist them. Only the `notes` array (and `layout`, if added) is saved.

---

## Known limitations / planned future work

- **No multi-board UI** — the board name is hardcoded to `"default"` in `canvas.js`. The backend already supports named boards via `GET/POST /board/:name`; a board switcher in the toolbar just needs frontend wiring. (Reframed as "one board per rabbit-hole" in the roadmap.)
- **Explore moves are a fixed set** — LLM-generated *contextual* suggestions (Perplexity-style, derived from the answer) are a deferred next step. Root-prompt moves aren't unified with the follow-up set yet.
- **Keyboard-first interaction** — visible focus rings + key shortcuts (`n`/`Enter`/`Esc`/`Del`) are the remaining ND-credibility-basics item (next up).
- **Token counter** — planned: a small label on response cards showing e.g. `4 cards · ~3,200 tokens`.
- **Chain summarization** — deprioritized: a user-triggered "Collapse into summary card" for very long chains.
- **Understanding markers / spaced review** — *demoted to optional*. The tool's soul is discovery, not memorization; markers would be an opt-in retention add-on, not a headline.
