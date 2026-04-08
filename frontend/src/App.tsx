import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import './index.css'

type Message = {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  nodes?: string[]
}

type TreeNode = {
  node_id: string
  title: string
  page_index?: number
  text?: string
  nodes?: TreeNode[]
}

// Recursive Tree Node Component
const RenderTreeOpts = ({ nodes, highlightedNodes }: { nodes: TreeNode[], highlightedNodes: string[] }) => {
  return (
    <>
      {nodes.map(node => (
        <div key={node.node_id} className={`tree-node ${highlightedNodes.includes(node.node_id) ? 'highlighted' : ''}`}>
          <div className="tree-node-header">
            <span>{node.title}</span>
            <span className="badge">ID: {node.node_id} | Pg: {node.page_index || '?'}</span>
          </div>
          {node.text && (
            <div className="tree-node-content">
              Summary: {node.text.slice(0, 100)}...
              <br/>
              <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                Est. Length: {node.text.length} chars
              </span>
            </div>
          )}
          {node.nodes && node.nodes.length > 0 && (
            <div className="tree-children">
              <RenderTreeOpts nodes={node.nodes} highlightedNodes={highlightedNodes} />
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [docId, setDocId] = useState<string>('')
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  
  // Model state defaults to a free version
  const [model, setModel] = useState('openrouter/free')

  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages])

  const handleUpload = async () => {
    if (!file) return
    setIsLoading(true)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      })
      const data = await res.json()
      if (data.doc_id) {
        setDocId(data.doc_id)
        setTree(data.tree)
        alert('File uploaded and indexed successfully!')
      } else {
        alert('Error: ' + JSON.stringify(data))
      }
    } catch (e) {
      alert('Upload failed: ' + String(e))
    }
    setIsLoading(false)
  }

  const handleSend = async () => {
    if (!query.trim() || !docId) return
    const userMsg = query
    setMessages(prev => [...prev, { role: 'user', content: userMsg }])
    setQuery('')
    setIsLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMsg, doc_id: docId, tree, model })
      })
      const data = await res.json()
      
      if (data.answer) {
        setMessages(prev => [
          ...prev, 
          { role: 'assistant', content: data.answer, reasoning: data.thinking, nodes: data.node_ids }
        ])
      } else {
         setMessages(prev => [...prev, { role: 'assistant', content: 'Error: ' + JSON.stringify(data) }])
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error communicating with backend.' }])
    }
    setIsLoading(false)
  }

  // Find currently highlighted nodes from the last assistant message
  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant')
  const highlightedNodes = lastAssistantMsg?.nodes || []

  return (
    <div id="root">
      <div className="glass-panel main-chat">
        <div className="header">
          <h2>Vectorless RAG Chat</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Model: </span>
            <select className="select-dropdown" value={model} onChange={e => setModel(e.target.value)}>
              <optgroup label="Free Models">
                <option value="openrouter/free">Free Models Router (Free)</option>
                <option value="arcee-ai/trinity-large-preview">Arcee AI: Trinity Large Preview (Free)</option>
              </optgroup>
              <optgroup label="Paid / Standard Models">
                <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (Paid)</option>
                <option value="anthropic/claude-3-haiku">Claude 3 Haiku (Paid)</option>
                <option value="meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B (Paid)</option>
              </optgroup>
            </select>
          </div>
        </div>

        <div className="controls-row">
          <input className="file-input" type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} />
          <button className="btn-primary" onClick={handleUpload} disabled={isLoading || !file || !!docId} style={{ padding: '8px 16px', fontSize: '0.9rem' }}>
            {isLoading && !docId ? 'Uploading...' : docId ? '✅ Uploaded' : 'Upload PDF'}
          </button>
          {docId && <span style={{ fontSize: '0.85rem', color: '#059669', fontWeight: 500 }}>Index Ready (ID: {docId.slice(0, 8)}...)</span>}
        </div>

        <div className="chat-history" ref={chatRef}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <div style={{ fontSize: '3rem', marginBottom: '16px' }}>📚</div>
              <h3>Welcome to PageIndex RAG</h3>
              <p>Upload a PDF document to begin reasoning over its structure.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`message-wrapper ${m.role}`}>
                <div className={`bubble ${m.role}`}>
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                  
                  {m.reasoning && (
                    <div className="reasoning-box">
                      <strong>🧠 Reasoning Trace:</strong>
                      <p style={{ margin: '4px 0 0 0' }}>{m.reasoning}</p>
                      {m.nodes && m.nodes.length > 0 && (
                         <div style={{ marginTop: '8px', fontSize: '0.8rem', color: '#0ea5e9', fontWeight: 600 }}>
                           → Retrieved Nodes: {m.nodes.join(', ')}
                         </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {isLoading && docId && (
            <div className="message-wrapper assistant">
              <div className="bubble assistant text-slate-400">
                Processing query and searching tree space...
              </div>
            </div>
          )}
        </div>

        <div className="input-area">
          <input 
            className="chat-input"
            type="text" 
            value={query} 
            onChange={e => setQuery(e.target.value)} 
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder={docId ? "Ask a question about the document..." : "Please upload a PDF first..."}
            disabled={isLoading || !docId}
          />
          <button className="btn-primary" onClick={handleSend} disabled={isLoading || !query.trim() || !docId}>
             Send 
          </button>
        </div>
      </div>

      <div className="glass-panel side-panel">
        <div className="header" style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
          <h2>PageIndex Trace</h2>
        </div>
        <div className="tree-container">
          {!tree ? (
             <div className="empty-state" style={{ height: '200px' }}>
               <p>No document indexed yet.</p>
             </div>
          ) : (
             <RenderTreeOpts nodes={tree} highlightedNodes={highlightedNodes} />
          )}
        </div>
      </div>
    </div>
  )
}

export default App
