## Vectorless RAG Chatbot

FastAPI + React application for document Q&A using PageIndex tree-based retrieval (vectorless RAG).

### Features

- PDF upload and asynchronous indexing via PageIndex
- Flow-based trace panel showing query mapping and retrieved chunks
- Tree-structured retrieval over document sections
- Multi-model chat routing with Gemini-first defaults
- Friendly handling for common upstream errors (`InsufficientCredits`, `LimitReached`)

### Tech Stack

- Backend: FastAPI, Uvicorn, PageIndex SDK, OpenAI-compatible clients
- Frontend: React, TypeScript, Vite
- Python dependency management: `pyproject.toml`

### Project Structure

```text
.
├── main.py                  # FastAPI backend
├── pyproject.toml           # Python dependencies
├── frontend/
│   ├── src/App.tsx          # Main UI and chat flow
│   ├── src/index.css        # UI styling
│   └── package.json         # Frontend scripts/deps
└── README.md
```

### Prerequisites

- Python 3.11+
- Node.js 18+
- npm

### Environment Variables

Create a `.env` file in the project root:

```env
PAGEINDEX_API_KEY=your_pageindex_key
GEMINI_API_KEY=your_gemini_key

# Optional: only needed if selecting OpenRouter models from the UI
OPENROUTER_API_KEY=your_openrouter_key
```

### Backend Setup

```bash
# From project root
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
```

Run backend:

```bash
uvicorn main:app --reload
```

Backend runs on `http://127.0.0.1:8000`.

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://127.0.0.1:5173`.

### Development Workflow

1. Start backend from project root
2. Start frontend from `frontend/`
3. Open the frontend URL
4. Upload PDF and wait for `Index Ready`
5. Ask questions in chat

### API Overview

- `GET /api/health`
	- Basic service health and client availability
- `POST /api/upload`
	- Upload PDF, returns `doc_id` and processing status
- `GET /api/upload-status/{doc_id}`
	- Poll indexing status and fetch generated tree when complete
- `POST /api/chat`
	- Run tree search + grounded answer generation

### Error Handling Notes

- `402 InsufficientCredits`: PageIndex credits exhausted
- `429 LimitReached`: PageIndex usage limit hit
- `400 Document index is not ready yet`: chat sent before indexing completed

### Build & Validation

Frontend production build:

```bash
cd frontend
npm run build
```

Backend syntax check:

```bash
python -m py_compile main.py
```

### Troubleshooting

- If `.env` keys were changed, restart backend so keys reload
- If upload succeeds but chat fails, ensure `Index Ready` appears before asking
- If Gemini model errors occur, select a supported Gemini option in the model picker
- If CORS/network errors appear, verify backend is running on port 8000

### Security Notes

- Never commit `.env` or API keys
- Rotate keys if exposed
- Restrict CORS origins before deploying to production

### License
Add your preferred license here (for example, MIT).


