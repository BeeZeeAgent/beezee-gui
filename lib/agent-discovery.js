import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const BINARIES = [
  { cmd: 'claude', id: 'claude-code', name: 'Claude Code', icon: 'C', protocol: 'cli' },
  { cmd: 'codex', id: 'codex', name: 'Codex CLI', icon: 'X', protocol: 'direct' },
  { cmd: 'opencode', id: 'opencode', name: 'OpenCode', icon: 'O', protocol: 'acp', npxPackage: 'opencode-ai' },
  { cmd: 'gemini', id: 'gemini', name: 'Gemini CLI', icon: 'G', protocol: 'acp', npxPackage: '@google/gemini-cli' },
  { cmd: 'kilo', id: 'kilo', name: 'Kilo Code', icon: 'K', protocol: 'acp', npxPackage: '@kilocode/cli' },
  { cmd: 'goose', id: 'goose', name: 'Goose', icon: 'g', protocol: 'acp' },
  { cmd: 'openhands', id: 'openhands', name: 'OpenHands', icon: 'H', protocol: 'acp' },
  { cmd: 'augment', id: 'augment', name: 'Augment Code', icon: 'A', protocol: 'acp' },
  { cmd: 'cline', id: 'cline', name: 'Cline', icon: 'c', protocol: 'acp' },
  { cmd: 'kimi', id: 'kimi', name: 'Kimi CLI', icon: 'K', protocol: 'acp' },
  { cmd: 'qwen-code', id: 'qwen', name: 'Qwen Code', icon: 'Q', protocol: 'acp' },
  { cmd: 'mistral-vibe', id: 'mistral', name: 'Mistral Vibe', icon: 'M', protocol: 'acp' },
  { cmd: 'kiro', id: 'kiro', name: 'Kiro CLI', icon: 'k', protocol: 'acp' },
  { cmd: 'fast-agent', id: 'fast-agent', name: 'fast-agent', icon: 'F', protocol: 'acp' },
  { cmd: 'hermes', id: 'hermes', name: 'Hermes Agent', icon: 'h', protocol: 'acp' },
];

const CLI_WRAPPERS = [
  { id: 'cli-opencode', name: 'OpenCode', icon: 'O', protocol: 'cli-wrapper', acpId: 'opencode' },
  { id: 'cli-gemini', name: 'Gemini', icon: 'G', protocol: 'cli-wrapper', acpId: 'gemini' },
  { id: 'cli-kilo', name: 'Kilo', icon: 'K', protocol: 'cli-wrapper', acpId: 'kilo' },
];

export function findCommand(cmd, rootDir) {
  if (!cmd) return null;
  const isWindows = os.platform() === 'win32';
  if (!rootDir) {
    try {
      const result = execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 }).trim();
      return result ? (isWindows ? result.split('\n')[0].trim() : result) : null;
    } catch { return null; }
  }
  const localBin = path.join(rootDir, 'node_modules', '.bin', isWindows ? cmd + '.cmd' : cmd);
  if (fs.existsSync(localBin)) {
    console.log(`[agent-discovery] Found ${cmd} in local node_modules`);
    return localBin;
  }
  try {
    const timeoutMs = 10000;
    if (isWindows) {
      const result = execSync(`where ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
      if (result) {
        console.log(`[agent-discovery] Found ${cmd} in PATH`);
        return result.split('\n')[0].trim();
      }
    } else {
      const result = execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
      if (result) {
        console.log(`[agent-discovery] Found ${cmd} in PATH`);
        return result;
      }
    }
  } catch (err) {
    console.log(`[agent-discovery] ${cmd} not found or timed out`);
    return null;
  }
  return null;
}

export async function queryACPServerAgents(baseUrl) {
  const endpoint = baseUrl.endsWith('/') ? baseUrl + 'agents/search' : baseUrl + '/agents/search';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      console.error(`Failed to query ACP agents from ${baseUrl}: ${response.status}`);
      return [];
    }
    const data = await response.json();
    if (!data?.agents || !Array.isArray(data.agents)) {
      console.error(`Invalid agents response from ${baseUrl}`);
      return [];
    }
    return data.agents.map(agent => ({
      id: agent.agent_id || agent.id,
      name: agent.metadata?.ref?.name || agent.name || 'Unknown Agent',
      metadata: {
        ref: {
          name: agent.metadata?.ref?.name,
          version: agent.metadata?.ref?.version,
          url: agent.metadata?.ref?.url,
          tags: agent.metadata?.ref?.tags
        },
        description: agent.metadata?.description,
        author: agent.metadata?.author,
        license: agent.metadata?.license
      },
      specs: agent.specs ? {
        capabilities: agent.specs.capabilities,
        input_schema: agent.specs.input_schema || agent.specs.input,
        output_schema: agent.specs.output_schema || agent.specs.output,
        thread_state_schema: agent.specs.thread_state_schema || agent.specs.thread_state,
        config_schema: agent.specs.config_schema || agent.specs.config,
        custom_streaming_update_schema: agent.specs.custom_streaming_update_schema || agent.specs.custom_streaming_update
      } : null,
      custom_data: agent.custom_data,
      icon: agent.metadata?.ref?.name?.charAt(0) || 'A',
      protocol: 'acp',
      path: baseUrl
    }));
  } catch (error) {
    console.error(`ACP agents query failed for ${baseUrl}: ${error.message}`);
    return [];
  }
}

export function discoverAgents(rootDir) {
  const agents = [];
  for (const bin of BINARIES) {
    const result = findCommand(bin.cmd, rootDir);
    if (result) {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: result, protocol: bin.protocol });
    } else if (bin.npxPackage) {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: null, protocol: bin.protocol, npxPackage: bin.npxPackage, npxLaunchable: true });
    } else if (bin.id === 'claude-code') {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: null, protocol: bin.protocol, npxPackage: '@anthropic-ai/claude-code', npxLaunchable: true });
    }
  }

  console.log('[discoverAgents] Found agents:', agents.map(a => a.id).join(', '));
  for (const wrapper of CLI_WRAPPERS) {
    if (agents.some(a => a.id === wrapper.acpId)) {
      console.log(`[discoverAgents] Adding CLI wrapper for ${wrapper.id}`);
      agents.push(wrapper);
    } else {
      console.log(`[discoverAgents] Skipping CLI wrapper ${wrapper.id} (ACP agent ${wrapper.acpId} not found)`);
    }
  }
  const wrappedAcpIds = new Set(CLI_WRAPPERS.filter(w => agents.some(a => a.id === w.acpId)).map(w => w.acpId));
  const filtered = agents.filter(a => !wrappedAcpIds.has(a.id));
  console.log('[discoverAgents] Final agent count:', filtered.length, 'Agent IDs:', filtered.map(a => a.id).join(', '));
  return filtered;
}

export async function discoverExternalACPServers(discoveredAgents) {
  const externalAgents = [];
  for (const agent of discoveredAgents.filter(a => a.protocol === 'acp' && a.acpPort)) {
    try {
      const agents = await queryACPServerAgents(`http://localhost:${agent.acpPort}`);
      externalAgents.push(...agents);
    } catch (_) {}
  }
  return externalAgents;
}

export async function initializeAgentDiscovery(discoveredAgents, rootDir, logError) {
  try {
    const agents = discoverAgents(rootDir);
    discoveredAgents.length = 0;
    discoveredAgents.push(...agents);
    console.log('[AGENTS] Discovered:', discoveredAgents.map(a => ({ id: a.id, found: !!a.path, protocol: a.protocol })));
    console.log('[AGENTS] Total count:', discoveredAgents.length);
  } catch (err) {
    console.error('[AGENTS] Discovery error:', err.message);
    if (logError) logError('initializeAgentDiscovery', err);
  }
}
