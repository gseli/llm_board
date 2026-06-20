# LLM Board

A spatial **discovery** tool: a freeform, zoomable canvas where you prompt an LLM and grow a
horizontal **thought-tree** as you follow your curiosity. Think Obsidian Canvas meets a chat
interface.

You read something new, hit a term you don't know, and prompt it — the answer appears to the
**right**. From there you fork follow-ups ("why?", "give an example", "explain a term…"),
each branching further rightward into a tree. Tangents can **break out** into their own trees.
The point is *figuring things out and following the rabbit-hole* — discovery, not memorization.

<!-- ![LLM Board screenshot](docs/screenshot.png) -->

---

## Quick start

```bash
pip install -r requirements.txt
cp config.yaml.example config.yaml   # then open config.yaml and add your API key

cd backend
uvicorn main:app --reload
# open http://localhost:8000
```

That's it — no build step, no Node, no bundler.

---

## Getting an API key

LLM Board talks to one LLM provider at a time. Three are supported out of the box — **Groq and
Gemini both have generous free tiers**, so you can try the whole thing for $0:

| Provider | Get a key | Free tier? |
|---|---|---|
| **Mistral** | <https://console.mistral.ai/api-keys> | Yes (la Plateforme) |
| **Groq** | <https://console.groq.com/keys> | Yes |
| **Gemini** | <https://aistudio.google.com/app/apikey> | Yes |

Open `config.yaml` (the copy you made above) and:

1. Set the `provider:` line to `mistral`, `groq`, or `gemini`.
2. Fill in the matching key block. `config.yaml.example` ships with `mistral` active and the
   other two commented out — just uncomment the one you want and paste your key.

Your key lives in `config.yaml`, which is **gitignored** — it's never committed.

---

## Using the board

- **Write a prompt** in a prompt card, optionally pick a **Bloom's template** (a starting
  angle — explain, break it down, compare…), then **Run**.
- The **answer appears to the right** of your prompt.
- Each answer has floating **orbit pills** — click one to **fork a follow-up** (tell me more,
  why?, give an example, relate/compare…) into a new branch.
- **Drag** any card by its header to reposition it; nothing else moves.
- **✦ Tidy** (toolbar) auto-arranges the whole forest with a gentle glide.
- **Pan** by dragging empty space; **zoom** with the corner `+ / − / FIT` buttons,
  `Ctrl/⌘ + scroll`, or the `+` `-` `0` keys.
- **Break a term out** into its own standalone tree by selecting it in an answer.
- Made a mistake? Deletes are **undoable** from the toolbar.

---

## Your boards & data

Your board saves to `boards/<name>.json` automatically as you work — it's your data, and it's
gitignored by default, so it stays local to your machine.

There's currently a single board (`default`); a multi-board switcher is planned future work.

---

## Requirements

- **Python 3.10+**
- The pip dependencies in `requirements.txt` (FastAPI, uvicorn, httpx, PyYAML)
- A modern web browser

No Node.js is required to run the app.

---

## Project layout

```
LLM_Board/
├── backend/        # FastAPI server (main.py), LLM providers (llm.py), board storage
├── frontend/       # The canvas UI — vanilla JS/HTML/CSS, no framework
├── boards/         # Your saved boards (auto-created, gitignored)
├── config.yaml     # Your provider + API key (you create this; gitignored)
└── requirements.txt
```

For the deep architecture dive — the data model, the thought-tree internals, design
decisions — see [CLAUDE.md](CLAUDE.md).

---

## License

[MIT](LICENSE) © Elizabeth Graniel
