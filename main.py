import os
import json
import time
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from pageindex import PageIndexClient
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

PAGEINDEX_API_KEY = os.getenv("PAGEINDEX_API_KEY", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")

# We only instantiate clients if keys exist. Endpoint should handle missing keys gracefully.
try:
    pi_client = PageIndexClient(api_key=PAGEINDEX_API_KEY)
except:
    pi_client = None

# OpenAI client bound to OpenRouter
try:
    openai_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
    )
except:
    openai_client = None


@app.get("/api/health")
def health_check():
    return {"status": "ok", "pi_client": bool(pi_client), "openai_client": bool(openai_client)}


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
        result = pi_client.submit_document(file_path)
        doc_id = result.get("doc_id")
        if not doc_id:
            raise HTTPException(status_code=500, detail="Failed to get doc_id from PageIndex.")
        
        # Wait until processing is complete
        while True:
            status_result = pi_client.get_document(doc_id)
            status = status_result.get("status")
            if status == "completed":
                break
            elif status == "failed":
                raise HTTPException(status_code=500, detail="Document processing failed internally at PageIndex.")
            time.sleep(2)
            
        # Get tree
        tree_result = pi_client.get_tree(doc_id, node_summary=True)
        tree = tree_result.get("result", [])
        
        return {"doc_id": doc_id, "tree": tree}
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)

            
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
    
    response = openai_client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content


@app.post("/api/chat")
def chat_with_document(req: ChatRequest):
    if not openai_client or not OPENROUTER_API_KEY:
        raise HTTPException(status_code=500, detail="OpenRouter API Key missing. Check .env file.")
    
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
        search_res = openai_client.chat.completions.create(
            model=req.model,
            messages=[{"role": "user", "content": prompt_search}],
            response_format={"type": "json_object"}
        )
        search_content = search_res.choices[0].message.content
        search_data = json.loads(search_content)
    except json.JSONDecodeError as e:
        print("JSON Decode Error", e)
        # Simple extraction fallback just in case
        raise HTTPException(status_code=500, detail=f"Model {req.model} failed to return perfectly formatted JSON.")
    except Exception as e:
        print(f"OpenRouter Error: {e}")
        # Could be an OpenRouter Error, e.g. unsupported JSON format
        raise HTTPException(status_code=500, detail=str(e))
        
    thinking = search_data.get("thinking", "")
    node_ids = search_data.get("node_list", [])
    
    # Step 2: Retrieve Nodes
    retrieved_nodes = find_nodes_by_ids(req.tree, node_ids)
    
    # Step 3: Generation
    answer = generate_answer(req.query, retrieved_nodes, req.model)
    
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
