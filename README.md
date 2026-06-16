# Parley

An AI job platform where a **candidate's agent** and an **employer's agent** parley —
talk like real people, gather *verifiable* information, and report back to their humans.
The humans decide; the agents are bounded gofers that never score anyone.

It runs with **no API key** (a deterministic mock drives the full pipeline). To
run the agents on a real model, drop a free **Groq** key into `.env` — or point
it at any OpenAI-compatible free tier (Together, OpenRouter, Cerebras, local
Ollama).

```bash
npm install
cp .env.example .env     # optional: add GROQ_API_KEY for live agents
npm run dev              # → http://localhost:4505
```

Get a free Groq key at https://console.groq.com/keys.

Then click **Seed demo**, open **Jobs**, and hit **Apply**. Watch the two agents
parley, listen to the recording (per-avatar voices), inspect every claim's
provenance, and read each side's report.

## The three layers

1. **Provenance** (`src/claims.ts`) — the agent never hands a human prose, it hands
   typed **Claims**. Each carries a source, evidence pointers, and a verification
   event kept *separate* from the assertion (so you can show "claimed 5y, evidence
   supports ~4y"). Tier is a pure function of `source + verification`; only
   connectors/the orchestrator can raise it — never the conversational model.

2. **The parley** (`src/orchestrator.ts`) — a referee owns the loop. Agents work an
   **agenda** and a **disclosure policy**; the other side's text is fenced as
   untrusted input; the orchestrator (not the agent) writes claims; an agent that
   can't answer from its store emits a **followup** instead of inventing
   ("let me check and get back to you"). Budgets and termination are explicit.

3. **The model** (`src/provider.ts`) — behind an interface: any OpenAI-compatible
   chat API (Groq by default) when a key is present, a deterministic mock
   otherwise. Persona/voice is style only, never substance. Structured turns use
   JSON mode, with a defensive parse + safe fallback so a model hiccup never
   breaks a parley.

## Config

`.env` is loaded automatically (see `.env.example`).

| Env | Default | |
|---|---|---|
| `GROQ_API_KEY` | — | unset (and no `LLM_API_KEY`) → mock provider |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | any Groq model id |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — | use any other OpenAI-compatible provider; takes precedence over `GROQ_*` |
| `PORT` | `4505` | |

Storage is a single JSON file at `data/db.json` (behind a repository interface —
swap for SQLite later without touching callers).
