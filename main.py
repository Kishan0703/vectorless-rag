import os
import json
import time
import threading
import re
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from pageindex import PageIndexClient, PageIndexAPIError
from openai import OpenAI

load_dotenv()

app = FastAPI(title="Vectorless RAG API")

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PAGEINDEX_API_KEY  = os.getenv("PAGEINDEX_API_KEY", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
GEMINI_API_KEY     = os.getenv("GEMINI_API_KEY", "")

# PageIndex client
try:
    pi_client = PageIndexClient(api_key=PAGEINDEX_API_KEY)
except:
    pi_client = None

# OpenRouter client (non-Gemini models)
try:
    openrouter_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
    )
except:
    openrouter_client = None

# Gemini via Google's OpenAI-compatible endpoint
gemini_client = (
    OpenAI(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        api_key=GEMINI_API_KEY,
    )
    if GEMINI_API_KEY else None
)

upload_jobs = {}

DEFAULT_GEMINI_MODEL = "gemini-2.0-flash"
SUPPORTED_GEMINI_MODELS = {
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
}


def _update_upload_job(doc_id: str, **updates):
    job = upload_jobs.setdefault(doc_id, {})
    job.update(updates)


def _poll_pageindex_job(doc_id: str):
    try:
        while True:
            status_result = pi_client.get_document(doc_id)
            status = status_result.get("status")
            if status == "completed":
                tree_result = pi_client.get_tree(doc_id, node_summary=True)
                tree = tree_result.get("result", [])
                _update_upload_job(doc_id, status="completed", tree=tree)
                return
            if status == "failed":
                _update_upload_job(doc_id, status="failed", error="Document processing failed internally at PageIndex.")
                return
            time.sleep(2)
    except Exception as e:
        _update_upload_job(doc_id, status="failed", error=str(e))


def get_client(model: str) -> OpenAI:
    """Route to the correct API client based on model name prefix."""
    if model.startswith("gemini"):
        if not gemini_client:
            raise HTTPException(status_code=500, detail="GEMINI_API_KEY is missing in .env")
        return gemini_client
    else:
        if not openrouter_client:
            raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY is missing in .env")
        return openrouter_client


def normalize_model(model: str) -> str:
    if model.startswith("gemini"):
        if model in SUPPORTED_GEMINI_MODELS:
            return model
        return DEFAULT_GEMINI_MODEL
    return model


def _parse_tree_search_response(raw_text: str) -> dict:
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", raw_text)
        if not match:
            raise
        return json.loads(match.group(0))


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "pi_client": bool(pi_client),
        "openrouter_client": bool(openrouter_client),
        "gemini_client": bool(gemini_client),
    }


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    if not pi_client or not PAGEINDEX_API_KEY:
        raise HTTPException(status_code=500, detail="PageIndex API Key missing. Check .env file.")
    
    # Save file temporarily
    file_path = f"/tmp/{file.filename}"
    with open(file_path, "wb") as buffer:
        buffer.write(await file.read())
        
    try:
        # Upload to PageIndex
        try:
            result = pi_client.submit_document(file_path)
        except PageIndexAPIError as e:
            message = str(e)
            if "InsufficientCredits" in message:
                raise HTTPException(status_code=402, detail="InsufficientCredits")
            if "LimitReached" in message:
                raise HTTPException(status_code=429, detail="LimitReached")
            raise HTTPException(status_code=502, detail=message)

        doc_id = result.get("doc_id")
        if not doc_id:
            raise HTTPException(status_code=500, detail="Failed to get doc_id from PageIndex.")

        _update_upload_job(doc_id, status="processing", tree=None, error=None)
        threading.Thread(target=_poll_pageindex_job, args=(doc_id,), daemon=True).start()

        return {"doc_id": doc_id, "status": "processing"}
    except HTTPException:
        raise  # Re-raise our own HTTP errors unchanged
    except Exception as e:
        # Catch PageIndexAPIError and any other exceptions
        message = str(e)
        if "InsufficientCredits" in message:
            raise HTTPException(status_code=402, detail="InsufficientCredits")
        if "LimitReached" in message:
            raise HTTPException(status_code=429, detail="LimitReached")
        raise HTTPException(status_code=502, detail=message)
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)


@app.get("/api/upload-status/{doc_id}")
def get_upload_status(doc_id: str):
    job = upload_jobs.get(doc_id)
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found.")
    return {"doc_id": doc_id, **job}

            
class ChatRequest(BaseModel):
    query: str
    doc_id: str
    tree: list
    model: str = "google/gemini-2.5-flash"


def compress_tree(nodes):
    out = []
    for n in nodes:
        entry = {
            "node_id": n.get("node_id"),
            "title": n.get("title"),
            "page": n.get("page_index", "?"),
            "summary": n.get("text", "")[:150]
        }
        if n.get("nodes"):
            entry["children"] = compress_tree(n["nodes"])
        out.append(entry)
    return out

def find_nodes_by_ids(tree, target_ids):
    found = []
    for node in tree:
        if node.get("node_id") in target_ids:
            found.append(node)
        if node.get("nodes"):
            found.extend(find_nodes_by_ids(node["nodes"], target_ids))
    return found

def generate_answer(query: str, nodes: list, model: str):
    if not nodes:
        return "⚠️ No relevant sections found in the document."
    
    context_parts = []
    for node in nodes:
        context_parts.append(
            f"[Section: '{node.get('title')}' | Page {node.get('page_index', '?')}]\n"
            f"{node.get('text', 'Content not available.')}"
        )
    context = "\n\n---\n\n".join(context_parts)
    
    prompt = f"""You are an expert document analyst.
Answer the question using ONLY the provided context.
For every claim you make, cite the section title and page number in parentheses.
Be concise and precise. Return format in text/markdown.

Question: {query}

Context:
{context}

Answer:"""
    
    normalized_model = normalize_model(model)
    client = get_client(normalized_model)
    response = client.chat.completions.create(
        model=normalized_model,
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content


@app.post("/api/chat")
def chat_with_document(req: ChatRequest):
    # Validate that the right client/key exists before doing any work
    model = normalize_model(req.model)
    get_client(model)  # raises HTTPException if key is missing
    
    if not isinstance(req.tree, list) or len(req.tree) == 0:
        raise HTTPException(status_code=400, detail="Document index is not ready yet. Please wait for indexing to complete.")

    t0 = time.time()
    compressed = compress_tree(req.tree)
    
    # Step 1: OpenRouter Tree Search
    prompt_search = f"""You are given a query and a document's tree structure (like a Table of Contents).
Your task: identify which node IDs most likely contain the answer to the query.
Think step-by-step about which sections are relevant.

Query: {req.query}

Document Tree:
{json.dumps(compressed, indent=2)}

Reply ONLY in this exact JSON format:
{{
  "thinking": "<your step-by-step reasoning>",
  "node_list": ["node_id1", "node_id2"]
}}"""

    try:
        client = get_client(model)
        try:
            search_res = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt_search}],
                response_format={"type": "json_object"}
            )
            search_content = search_res.choices[0].message.content
            search_data = _parse_tree_search_response(search_content)
        except Exception:
            # Fallback for providers/models that ignore or reject response_format=json_object.
            fallback_res = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt_search}]
            )
            fallback_content = fallback_res.choices[0].message.content
            search_data = _parse_tree_search_response(fallback_content)
    except json.JSONDecodeError as e:
        print("JSON Decode Error", e)
        # Simple extraction fallback just in case
        raise HTTPException(status_code=500, detail=f"Model {model} failed to return perfectly formatted JSON.")
    except Exception as e:
        print(f"LLM Error: {e}")
        # Could be a provider error, e.g. unsupported JSON format
        raise HTTPException(status_code=500, detail=str(e))
        
    thinking = search_data.get("thinking", "")
    node_ids = search_data.get("node_list", [])
    
    # Step 2: Retrieve Nodes
    retrieved_nodes = find_nodes_by_ids(req.tree, node_ids)
    
    # Step 3: Generation
    answer = generate_answer(req.query, retrieved_nodes, model)
    
    t1 = time.time()
    return {
        "answer": answer,
        "thinking": thinking,
        "node_ids": node_ids,
        "latency_ms": round((t1 - t0) * 1000)
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
