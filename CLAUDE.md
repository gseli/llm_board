# LLM Board — Agent Guide

A spatial learning tool: a freeform canvas where you post notes and prompt an LLM. Think Obsidian Canvas meets a chat interface. The core use case is reading something new, hitting unknown terms, and building a visual map of your understanding as you investigate them.

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
│   ├── canvas.js     # State, rendering, drag, resize, chain logic
│   ├── notes.js      # Note card DOM construction + Bloom's templates
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
| `prompt` | Textarea + template selector + Run button. Spawns a response note below. |
| `response` | LLM output, read-only. Has a "↩ follow up" button to continue the thread. |

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
  "prompt_template": "explain_term",
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

## Bloom's Taxonomy templates

Defined in `frontend/notes.js` → `TEMPLATES` array. Each template:

```js
{
  id: "break_it_down",
  bloom: "analyze",          // remember | understand | apply | analyze | evaluate
  label: "Break it into parts",
  build: (input) => `Break "${input}" into its key components...`
}
```

The prompt note header renders a badge (`symbol + level`) and gets a subtle background tint based on the selected template's Bloom's level. Both update live when the user changes the template dropdown.

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
- **`renderAll()` is the single source of truth** — when state changes, call `renderAll()`. Do not try to do partial DOM updates; the canvas is wiped and redrawn each time.

---

## Known limitations / planned future work

- **No multi-board UI** — the board name is hardcoded to `"default"` in `canvas.js`. The backend already supports named boards via `GET/POST /board/:name`; a board switcher in the toolbar just needs frontend wiring.
- **Token counter** — planned: a small label on response cards showing e.g. `4 cards · ~3,200 tokens`.
- **Chain summarization** — planned: a user-triggered "Collapse into summary card" action for very long chains.
- **Understanding markers** — future: marking a card "got it" / "still fuzzy" to support spaced review.
