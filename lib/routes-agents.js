import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getAgentDescriptor } from './agent-descriptors.js';
import { discoverExternalACPServers } from './agent-discovery.js';

export function register(deps) {
  const { sendJSON, parseBody, queries, discoveredAgents, getACPStatus, modelCache, getModelsForAgent, debugLog } = deps;
  const routes = {};

  routes['GET /api/agents'] = async (req, res) => {
    debugLog(`[API /api/agents] Returning ${discoveredAgents.length} agents`);
    sendJSON(req, res, 200, { agents: discoveredAgents });
  };

  routes['GET /api/acp/status'] = async (req, res) => {
    sendJSON(req, res, 200, { tools: getACPStatus() });
  };

  routes['POST /api/agents/search'] = async (req, res) => {
    const body = await parseBody(req);
    try {
      const localResult = queries.searchAgents(discoveredAgents, body);
      const externalAgents = await discoverExternalACPServers(discoveredAgents);
      const externalResult = queries.searchAgents(externalAgents, body);
      sendJSON(req, res, 200, {
        agents: [...localResult.agents, ...externalResult.agents],
        total: localResult.total + externalResult.total,
        limit: body.limit || 50, offset: body.offset || 0,
        hasMore: localResult.hasMore || externalResult.hasMore,
      });
    } catch (error) {
      console.error('Error searching agents:', error);
      sendJSON(req, res, 200, queries.searchAgents(discoveredAgents, body));
    }
  };

  routes['GET /api/agents/auth-status'] = async (req, res) => {
    const statuses = discoveredAgents.map(agent => {
      const status = { id: agent.id, name: agent.name, authenticated: false, detail: '' };
      try {
        if (agent.id === 'claude-code') {
          const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
          if (fs.existsSync(credFile)) {
            const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
            if (creds.claudeAiOauth && creds.claudeAiOauth.expiresAt > Date.now()) {
              status.authenticated = true;
              status.detail = creds.claudeAiOauth.subscriptionType || 'authenticated';
            } else { status.detail = 'expired'; }
          } else { status.detail = 'no credentials'; }
        } else if (agent.id === 'gemini') {
          const oauthFile = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
          const acctFile = path.join(os.homedir(), '.gemini', 'google_accounts.json');
          let hasOAuth = false;
          if (fs.existsSync(oauthFile)) {
            try { const creds = JSON.parse(fs.readFileSync(oauthFile, 'utf-8')); if (creds.refresh_token || creds.access_token) hasOAuth = true; } catch (_) {}
          }
          if (fs.existsSync(acctFile)) {
            const accts = JSON.parse(fs.readFileSync(acctFile, 'utf-8'));
            if (accts.active) { status.authenticated = true; status.detail = accts.active; }
            else if (hasOAuth) { status.authenticated = true; status.detail = 'oauth'; }
            else { status.detail = 'logged out'; }
          } else if (hasOAuth) { status.authenticated = true; status.detail = 'oauth'; }
          else { status.detail = 'no credentials'; }
        } else if (agent.id === 'opencode') {
          const out = execSync('opencode auth list 2>&1', { encoding: 'utf-8', timeout: 5000 });
          const countMatch = out.match(/(\d+)\s+credentials?/);
          if (countMatch && parseInt(countMatch[1], 10) > 0) { status.authenticated = true; status.detail = countMatch[1] + ' credential(s)'; }
          else { status.detail = 'no credentials'; }
        } else { status.detail = 'unknown'; }
      } catch (e) { status.detail = 'check failed'; }
      return status;
    });
    sendJSON(req, res, 200, { agents: statuses });
  };

  routes['_match'] = (method, pathOnly) => {
    const key = `${method} ${pathOnly}`;
    if (routes[key]) return routes[key];
    let m;
    if (method === 'GET' && (m = pathOnly.match(/^\/api\/agents\/([^/]+)$/)))
      return (req, res) => handleGetAgent(req, res, m[1]);
    if (method === 'GET' && (m = pathOnly.match(/^\/api\/agents\/([^/]+)\/descriptor$/)))
      return (req, res) => { const d = getAgentDescriptor(m[1]); d ? sendJSON(req, res, 200, d) : sendJSON(req, res, 404, { error: 'Agent not found' }); };
    if (method === 'GET' && (m = pathOnly.match(/^\/api\/agents\/([^/]+)\/models$/)))
      return (req, res) => handleGetModels(req, res, m[1]);
    return null;
  };

  async function handleGetAgent(req, res, agentId) {
    const agent = discoveredAgents.find(a => a.id === agentId);
    if (!agent) { sendJSON(req, res, 404, { error: 'Agent not found' }); return; }
    sendJSON(req, res, 200, { id: agent.id, name: agent.name, description: agent.description || '', icon: agent.icon || null, status: 'available' });
  }

  async function handleGetModels(req, res, agentId) {
    const cached = modelCache.get(agentId);
    if (cached && (Date.now() - cached.timestamp) < 300000) { sendJSON(req, res, 200, { models: cached.models }); return; }
    try {
      const models = await getModelsForAgent(agentId);
      modelCache.set(agentId, { models, timestamp: Date.now() });
      sendJSON(req, res, 200, { models });
    } catch (err) { sendJSON(req, res, 200, { models: [] }); }
  }

  return routes;
}
