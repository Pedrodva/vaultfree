// Minimal Model Context Protocol server (stdio, JSON-RPC 2.0) backed by the VaultFree REST API.
// Works with Claude Desktop/Code, Cursor, and any MCP client. Zero dependencies.
import readline from 'node:readline';
import { VERSION } from './config.js';

const vaultProp = { type: 'string', description: 'Vault id (optional if you only have one or VAULTFREE_VAULT is set)' };
const TOOLS = [
  { name: 'vaultfree_list_vaults', description: 'List vaults you can access.', inputSchema: { type: 'object', properties: {} } },
  { name: 'vaultfree_search', description: 'Full-text search. Supports "phrases", tag:name and path:folder filters.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'vaultfree_read_note', description: 'Read a note: content, rev (needed for updates), links and backlinks.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, path: { type: 'string' } }, required: ['path'] } },
  { name: 'vaultfree_write_note', description: 'Create or update a note. For existing notes pass base_rev from vaultfree_read_note; concurrent edits are merged, real conflicts return an error with the current content.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, path: { type: 'string' }, content: { type: 'string' }, base_rev: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'vaultfree_append_note', description: 'Append text to a note (creates it if missing). Never conflicts; best for logs and quick capture.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } },
  { name: 'vaultfree_propose_change', description: 'Propose a change for a person to review and accept (use this if your token cannot write directly). Send either content (the whole new note, based on base_rev from vaultfree_read_note) or append (text to add). Add a short message explaining why.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, path: { type: 'string' }, content: { type: 'string' }, append: { type: 'string' }, base_rev: { type: 'string' }, message: { type: 'string' } }, required: ['path'] } },
  { name: 'vaultfree_list_proposals', description: 'List proposals (open ones by default) with their status.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, status: { type: 'string', enum: ['open', 'accepted', 'rejected'] } } } },
  { name: 'vaultfree_graph_neighbors', description: 'Notes connected to a note within N hops of the link graph.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, path: { type: 'string' }, depth: { type: 'number' } }, required: ['path'] } },
  { name: 'vaultfree_get_context', description: 'Return an LLM-ready pack of the notes most relevant to a question.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, query: { type: 'string' }, budget_chars: { type: 'number' } }, required: ['query'] } },
  { name: 'vaultfree_list_notes', description: 'List notes (path, title, tags), optionally limited to a folder prefix.',
    inputSchema: { type: 'object', properties: { vault: vaultProp, folder: { type: 'string' } } } },
  { name: 'vaultfree_list_tags', description: 'List all tags with counts.', inputSchema: { type: 'object', properties: { vault: vaultProp } } },
];

export function createMcpHandler({ url, token, defaultVault, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '');
  const api = async (method, path, body) => {
    const res = await fetchImpl(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error?.message || res.statusText); e.data = data.error; throw e; }
    return data;
  };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const vaultOf = async (a) => {
    if (a.vault) return a.vault;
    if (defaultVault) return defaultVault;
    const { vaults } = await api('GET', '/api/vaults');
    if (vaults.length === 1) return vaults[0].id;
    throw new Error(`Specify "vault". Available: ${vaults.map((v) => v.id).join(', ')}`);
  };

  const impl = {
    vaultfree_list_vaults: async () => (await api('GET', '/api/vaults')).vaults,
    vaultfree_search: async (a) => (await api('GET', `/api/vaults/${await vaultOf(a)}/search?q=${encodeURIComponent(a.query)}&limit=${a.limit || 10}`)).results,
    vaultfree_read_note: async (a) => api('GET', `/api/vaults/${await vaultOf(a)}/notes/${enc(a.path)}`),
    vaultfree_write_note: async (a) => api('PUT', `/api/vaults/${await vaultOf(a)}/notes/${enc(a.path)}`, { content: a.content, baseRev: a.base_rev ?? null }),
    vaultfree_append_note: async (a) => api('POST', `/api/vaults/${await vaultOf(a)}/ops/append`, { path: a.path, text: a.text }),
    vaultfree_propose_change: async (a) => api('POST', `/api/vaults/${await vaultOf(a)}/proposals`, { path: a.path, content: a.content, append: a.append, baseRev: a.base_rev ?? null, message: a.message }),
    vaultfree_list_proposals: async (a) => (await api('GET', `/api/vaults/${await vaultOf(a)}/proposals?status=${a.status || 'open'}`)).proposals,
    vaultfree_graph_neighbors: async (a) => api('GET', `/api/vaults/${await vaultOf(a)}/graph?center=${encodeURIComponent(a.path)}&depth=${a.depth || 1}`),
    vaultfree_get_context: async (a) => api('GET', `/api/vaults/${await vaultOf(a)}/context?q=${encodeURIComponent(a.query)}&budget=${a.budget_chars || 12000}`),
    vaultfree_list_notes: async (a) => {
      const { notes } = await api('GET', `/api/vaults/${await vaultOf(a)}/notes`);
      return notes.filter((n) => !a.folder || n.path.startsWith(a.folder.replace(/\/?$/, '/'))).map(({ path, title, tags, rev }) => ({ path, title, tags, rev }));
    },
    vaultfree_list_tags: async (a) => (await api('GET', `/api/vaults/${await vaultOf(a)}/tags`)).tags,
  };

  /** Handle one JSON-RPC message; returns a response object or null for notifications. */
  return async function handle(msg) {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notification
    switch (method) {
      case 'initialize':
        return ok({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vaultfree', version: VERSION } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const fn = impl[params?.name];
        if (!fn) return err(-32602, `Unknown tool: ${params?.name}`);
        try {
          const out = await fn(params.arguments || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        } catch (e) {
          const detail = e.data ? '\n' + JSON.stringify(e.data, null, 2) : '';
          return ok({ isError: true, content: [{ type: 'text', text: e.message + detail }] });
        }
      }
      default: return err(-32601, `Method not found: ${method}`);
    }
  };
}

export function runMcpStdio(opts) {
  const handle = createMcpHandler(opts);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
