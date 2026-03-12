# Click Through Digital Landing Page

## Overview
Click Through Digital’s landing page is a compact marketing site that centers on the agency’s data-led positioning. The **hero** section greets visitors with the brand name, a business-focused tagline, a short narrative about SEO/social/paid/content campaigns, and a primary CTA that points to the contact page. Beneath the fold is a **services grid** that breaks down Search Engine Optimization, Social Media Marketing, Pay-Per-Click Advertising, and Content Marketing so prospects can scan key offerings quickly. The **testimonials** section features three rotating client stories with quotes, names, and companies for social proof. The persistent **chat widget** sits on every page, offering a live assistant, streaming responses, citation badges, and a tracker notice so visitors can get instant answers and signal fallbacks or escalations.

## Installation
1. Install **Node.js** (16+ recommended) and the bundled npm client so you can run the Express/WebSocket stack.
2. From the project root, install dependencies:

```bash
npm install
```

3. Start the combined frontend/back-end server:

```bash
npm start
```

The server listens on `PORT` (defaults to `3000`) and serves the marketing pages plus APIs and WebSocket endpoints used by the chat widget.

## Running the backend
The Express server in `server.js` powers the chat experiences and tracker integrations:

- `POST /api/chatbot` – Receives `{"message":"..."}` payloads, runs the keyword-driven intent analyzer, and returns a JSON response with `response` text plus `metadata` (intent, confidence, keywords, requestId, citations, fallback/escalation flags). The metadata is consumed by `chat-widget.js` to render confidence badges, citation links, warnings, and escalation banners.
- `POST /api/tracker/log` – The widget calls this endpoint whenever metadata indicates a fallback, escalation, or handoff. Entries are timestamped in the server log (`console.log('[TrackerLog]', entry)`) so ops teams can review fallbacks.
- `WebSocket /api/tracker/events` – A `ws` server emits `tracker_entry_complete` and `data_refresh` events. `chat-widget.js` subscribes to this stream and surfaces inline system messages (e.g., `Tracker entry ... completed`).

The backend also serves the static marketing HTML (`index.html`, `services.html`, `about.html`, `contact.html`) and the supporting assets (`styles.css`, `chat-widget.js`).

## Project structure
- `index.html` – Home (hero, core services grid, testimonials, footer, and the chat widget markup).
- `services.html`, `about.html`, `contact.html` – Secondary marketing pages reused by the navbar.
- `styles.css` – Global styling for the navbar, hero, cards, testimonials, chat panel, and responsive tweaks.
- `chat-widget.js` – DOM-driven chat UI, streaming handler, metadata renderer (citations/confidence), fallback/escalation logging, and tracker WebSocket subscriber.
- `server.js` – Express/WS backend with intent rules, `/api/chatbot` and `/api/tracker` endpoints, and static file serving logic.
- `package.json` & `package-lock.json` – Node dependency manifest (Express 5.2.1 and `ws`).
- `rag_eval_questions.json` – FAQ dataset that the FAQ RAG evaluation harness uses as citation/fallback gold data.
- `evaluation_specification.json` – Defines the target endpoint, schema expectations, metrics (retrieval accuracy, citation coverage, hallucinaton rate, fallback correctness), and the required dataset path.
- `run_faq_rag_evaluation.py` – A simple Python harness that loads the spec and dataset, fires POST requests to the target endpoint, evaluates keyword/citation/fallback coverage, and writes `evaluation_report.json`.
- `evaluation_report.json` – The output summary of the last RAG evaluation run (tests run/passed/failed, retrieval accuracy, citation coverage, hallucination rate, fallback correctness, detailed case results).

## FAQ RAG citations & tracker logging notes
- Citation rendering in the chat panel relies on `metadata.citations` (or `metadata.sources`) returned by `/api/chatbot`. `chat-widget.js` normalizes the citation payload and adds clickable badges so users can verify sources before following up.
- The FAQ data in `rag_eval_questions.json` drives both manual QA (when you read the file) and the automated evaluation tool. `run_faq_rag_evaluation.py` combines that data with `evaluation_specification.json` to target `target_endpoint` (default `http://localhost:3001/api/chatbot`) and writes success/failure counts plus metrics to `evaluation_report.json`. Run the script with:

```bash
python run_faq_rag_evaluation.py
```

- Tracker logging is two-fold: every fallback/escalation triggers a POST to `/api/tracker/log` (see `logTrackerEvent` in `chat-widget.js`), and the WebSocket stream at `/api/tracker/events` emits `tracker_entry_complete` and `data_refresh` events so visitors see live system messages. The backend prints tracker payloads to stdout for audit and future ingestion.

With this README in place, developers and QA can understand the landing page sections, start the server, interact with the chat + tracker, and run the FAQ RAG evaluation end-to-end.