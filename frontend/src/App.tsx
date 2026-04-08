import { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { Sun, Moon, Plus, ArrowUp, LayoutList, ChevronDown, FileText, Bot, Loader2 } from 'lucide-react'
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

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where',
  'which', 'who', 'why', 'with', 'you', 'your', 'about', 'into', 'over', 'under'
])

const extractKeywords = (input: string): string[] => {
  if (!input.trim()) return []
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const unique: string[] = []
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || unique.includes(w)) continue
    unique.push(w)
    if (unique.length === 8) break
  }
  return unique
}

const collectNodeLookup = (nodes: TreeNode[], map: Map<string, TreeNode> = new Map()): Map<string, TreeNode> => {
  for (const node of nodes) {
    map.set(node.node_id, node)
    if (node.nodes?.length) collectNodeLookup(node.nodes, map)
  }
  return map
}

const levelForDepth = (depth: number) => {
  if (depth === 0) return 'Module'
  if (depth === 1) return 'Chapter'
  return 'Section'
}

const FlowchartNode = ({
  node,
  highlightedNodes,
  hasActiveSelection,
  depth = 0,
}: {
  node: TreeNode,
  highlightedNodes: string[],
  hasActiveSelection: boolean,
  depth?: number
}) => {
  const isHighlighted = highlightedNodes.includes(node.node_id)
  const isDimmed = hasActiveSelection && !isHighlighted
  return (
    <div className="flow-branch" style={{ marginLeft: depth > 0 ? 20 : 0 }}>
      <div className={`flow-node ${isHighlighted ? 'highlighted' : ''} ${isDimmed ? 'dimmed' : ''}`}>
        <div className="flow-level-chip">{levelForDepth(depth)}</div>
        <div className="flow-title">
          <span>{node.title}</span>
          <span className={`node-chip ${isHighlighted ? 'highlighted' : ''}`}>{node.node_id}</span>
        </div>
        <div className="flow-meta">
          <span>Pg: {node.page_index || '?'}</span>
          <span>Tokens/Length: {node.text?.length || 0}</span>
        </div>
        {node.text && (
          <div className="flow-summary">
            {node.text.slice(0, 100)}...
          </div>
        )}
      </div>
      {node.nodes?.length ? (
        <div className="flow-children">
          {node.nodes.map(child => (
            <FlowchartNode
              key={child.node_id}
              node={child}
              highlightedNodes={highlightedNodes}
              hasActiveSelection={hasActiveSelection}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [docId, setDocId] = useState<string>('')
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  
  const [model, setModel] = useState('gemini-2.0-flash')
  const [isDark, setIsDark] = useState(false)
  const [showTrace, setShowTrace] = useState(false)

  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.body.classList.toggle('dark', isDark)
  }, [isDark])

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsUploading(true)
    setUploadError(null)
    setDocId('')
    setTree(null)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      })
      if (!res.ok) {
        const errorData = await res.json().catch(() => null)
        const msg = errorData?.detail || `HTTP ${res.status}`
        const isCreditsError = String(msg).includes('InsufficientCredits') || res.status === 402
        const isLimitReached = String(msg).includes('LimitReached') || res.status === 429
        const friendlyMsg = isCreditsError
          ? 'Upload failed: PageIndex credits are exhausted. Add credits to your PageIndex account and try again.'
          : isLimitReached
            ? 'Upload failed: PageIndex usage limit reached. Wait for your quota reset or upgrade your plan, then try again.'
            : `Upload failed: ${msg}`
        setUploadError(friendlyMsg)
      } else {
        const data = await res.json()
        if (!data?.doc_id) {
          setUploadError('Upload failed: Unexpected response from the backend.')
          return
        }

        const uploadedDocId = data.doc_id
        setDocId(uploadedDocId)
        setTree(null)
        setUploadError(null)

        const pollUntilReady = async () => {
          while (true) {
            const statusRes = await fetch(`/api/upload-status/${uploadedDocId}`)
            const statusData = await statusRes.json().catch(() => null)

            if (!statusRes.ok) {
              setUploadError(`Upload failed: ${statusData?.detail || `HTTP ${statusRes.status}`}`)
              return
            }

            if (statusData?.status === 'completed' && statusData?.tree) {
              setTree(statusData.tree)
              setShowTrace(true)
              return
            }

            if (statusData?.status === 'failed') {
              setUploadError(`Upload failed: ${statusData?.error || 'PageIndex processing failed.'}`)
              return
            }

            await new Promise(resolve => setTimeout(resolve, 1000))
          }
        }

        void pollUntilReady()
      }
    } catch (err) {
      setUploadError('Upload failed: Could not reach the backend. Is the server running?')
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

  const handleSend = async () => {
    if (!query.trim() || !docId || !tree) return
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

  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant')
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  const highlightedNodes = lastAssistantMsg?.nodes || []
  const hasActiveSelection = highlightedNodes.length > 0
  const traceQuery = lastUserMsg?.content || ''

  const queryKeywords = useMemo(() => extractKeywords(traceQuery), [traceQuery])

  const selectedChunks = useMemo(() => {
    if (!tree || highlightedNodes.length === 0) return []
    const lookup = collectNodeLookup(tree)
    return highlightedNodes
      .map((id) => lookup.get(id))
      .filter((node): node is TreeNode => Boolean(node))
  }, [tree, highlightedNodes])

  return (
    <>
      <div className="top-bar">
        <h1 className="title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot /> Vectorless RAG
        </h1>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="icon-btn" onClick={() => setShowTrace(!showTrace)} title="Toggle Trace Panel">
            <LayoutList size={20} />
          </button>
          <button className="icon-btn" onClick={() => setIsDark(!isDark)} title="Toggle Dark Mode">
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
      </div>

      <div className="main-content">
        <div className="chat-container">
          <div className="chat-history" ref={chatRef}>
            {messages.length === 0 ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)' }}>
                <Bot size={48} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
                <h3>How can I help you today?</h3>
                <p>Upload a PDF document below to begin reasoning over its structure.</p>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`message-wrapper ${m.role}`}>
                  <div className={`bubble ${m.role}`}>
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                </div>
              ))
            )}
            {isLoading && docId && (
              <div className="message-wrapper assistant" style={{ alignSelf: 'flex-start' }}>
                <div className="bubble assistant">
                   <div className="loading-dots">
                     <span /> <span /> <span />
                   </div>
                </div>
              </div>
            )}
            
            {/* Show Reasoning Trace Link Below the last message visually attached to it */}
            {docId && lastAssistantMsg?.reasoning && !isLoading && (
              <div style={{ marginTop: '-12px', marginBottom: '24px', fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={() => setShowTrace(true)}>
                <span>✨ <strong>Reasoning generated:</strong> {lastAssistantMsg.reasoning.slice(0, 75)}...</span>
                <span style={{ textDecoration: 'underline' }}>View Trace Flowchart</span>
              </div>
            )}
          </div>

          <div className="input-area-wrapper">
            {uploadError && (
              <div className="upload-status upload-status-error" role="alert">
                {uploadError}
              </div>
            )}
            {isUploading && (
               <div style={{ fontSize: '0.8rem', color: 'var(--text-main)', marginBottom: '8px', marginLeft: '16px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '4px' }}>
                 <Loader2 size={14} className="lucide-spin" style={{ animation: 'pulse 1.4s infinite linear' }}/> Uploading and Mapping Document...
               </div>
            )}
            {docId && !isUploading && (
               <div style={{ fontSize: '0.8rem', color: tree ? '#10b981' : 'var(--text-muted)', marginBottom: '8px', marginLeft: '16px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '4px' }}>
                 {tree ? <FileText size={14} /> : <Loader2 size={14} className="lucide-spin" style={{ animation: 'pulse 1.4s infinite linear' }} />}
                 {tree ? `Index Ready (ID: ${docId.slice(0, 8)}...)` : `Index Processing (ID: ${docId.slice(0, 8)}...)`}
               </div>
            )}
            
            <div className="chat-input-bar">
              <label className="upload-label" title="Upload PDF">
                <input type="file" accept="application/pdf" onChange={handleFileChange} disabled={isLoading || isUploading} />
                <Plus size={20} />
              </label>

              <div className="model-select-wrapper">
                <select value={model} onChange={e => setModel(e.target.value)} title="Select LLM Model">
                  <optgroup label="Free Models">
                    <option value="openrouter/free">Free Models Router (Free)</option>
                    <option value="arcee-ai/trinity-large-preview">Arcee AI: Trinity Large Preview (Free)</option>
                  </optgroup>
                  <optgroup label="Gemini (Google AI)">
                    <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                    <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                    <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                  </optgroup>
                  <optgroup label="OpenRouter (Paid)">
                    <option value="anthropic/claude-3-haiku">Claude 3 Haiku</option>
                    <option value="meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B</option>
                  </optgroup>
                </select>
                <ChevronDown size={14} style={{ marginLeft: '-24px', marginRight: '10px', pointerEvents: 'none', color: 'var(--text-muted)' }} />
              </div>

              <textarea 
                className="text-input" 
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                placeholder={tree ? "Message Vectorless RAG..." : docId ? "Index is processing..." : "Upload a PDF first..."}
                disabled={isLoading || isUploading || !docId || !tree}
                rows={1}
                style={{ overflow: 'hidden' }}
              />

              <button className={`send-btn ${isLoading ? 'cancel' : ''}`} onClick={handleSend} disabled={isLoading || isUploading || (!query.trim() && !isLoading) || !docId || !tree}>
                 {isLoading ? <div style={{width:'10px', height:'10px', background:'white', borderRadius:'2px'}}/> : <ArrowUp size={20} strokeWidth={3} />}
              </button>
            </div>
          </div>
        </div>

        <div className={`trace-panel ${!showTrace ? 'collapsed' : ''}`}>
          <div className="trace-header">
            <span>PageIndex Flow</span>
            <button className="icon-btn" style={{ width: '32px', height: '32px' }} onClick={() => setShowTrace(false)}>
               <Plus size={16} style={{ transform: 'rotate(45deg)' }} />
            </button>
          </div>
          <div className="query-mapping">
            <div className="query-mapping-title">Query Mapping</div>
            <div className="query-flow-row">
              <div className="query-flow-step">
                <div className="query-flow-label">Query</div>
                <div className="query-flow-value">{traceQuery || 'Ask a question to view retrieval mapping.'}</div>
              </div>
              <div className="query-flow-arrow">-&gt;</div>
              <div className="query-flow-step">
                <div className="query-flow-label">Keyword Match</div>
                <div className="query-chip-wrap">
                  {queryKeywords.length ? queryKeywords.map((kw) => (
                    <span key={kw} className="query-chip">{kw}</span>
                  )) : <span className="query-flow-muted">No keywords yet.</span>}
                </div>
              </div>
              <div className="query-flow-arrow">-&gt;</div>
              <div className="query-flow-step">
                <div className="query-flow-label">Retrieved Chunks</div>
                <div className="query-chip-wrap">
                  {selectedChunks.length ? selectedChunks.map((node) => (
                    <span key={node.node_id} className="query-chip selected">{node.title}</span>
                  )) : <span className="query-flow-muted">No chunks selected yet.</span>}
                </div>
              </div>
            </div>
            <div className="query-structure-bridge">Highlighted chunks are marked in the structure below.</div>
          </div>
          <div className="flowchart-container">
            {!tree ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '40px' }}>
                 No document indexed yet.
              </div>
            ) : (
              <div className="flow-tree">
                {tree.map(node => (
                   <FlowchartNode
                     key={node.node_id}
                     node={node}
                     highlightedNodes={highlightedNodes}
                     hasActiveSelection={hasActiveSelection}
                   />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export default App
