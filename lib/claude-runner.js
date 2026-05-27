import { spawn, spawnSync } from 'child_process';

const isWindows = process.platform === 'win32';

export function getSpawnOptions(cwd, additionalOptions = {}) {
  const options = { cwd, ...additionalOptions };
  if (isWindows) options.shell = true;
  if (!options.env) options.env = { ...process.env };
  delete options.env.CLAUDECODE;
  return options;
}

export function resolveCommand(command, npxPackage) {
  const whichCmd = isWindows ? 'where' : 'which';
  const check = spawnSync(whichCmd, [command], { encoding: 'utf-8', timeout: 3000 });
  if (check.status === 0 && (check.stdout || '').trim()) return { cmd: command, prefixArgs: [] };
  if (npxPackage) {
    const npxCheck = spawnSync(whichCmd, ['npx'], { encoding: 'utf-8', timeout: 3000 });
    if (npxCheck.status === 0) return { cmd: 'npx', prefixArgs: ['--yes', npxPackage] };
    const bunCheck = spawnSync(whichCmd, ['bun'], { encoding: 'utf-8', timeout: 3000 });
    if (bunCheck.status === 0) return { cmd: 'bun', prefixArgs: ['x', npxPackage] };
  }
  return { cmd: command, prefixArgs: [] };
}

export class AgentRunner {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.command = config.command;
    this.protocol = config.protocol || 'direct';
    this.buildArgs = config.buildArgs || this.defaultBuildArgs;
    this.parseOutput = config.parseOutput || this.defaultParseOutput;
    this.supportsStdin = config.supportsStdin ?? true;
    this.closeStdin = config.closeStdin ?? false;
    this.supportedFeatures = config.supportedFeatures || [];
    this.protocolHandler = config.protocolHandler || null;
    this.requiresAdapter = config.requiresAdapter || false;
    this.adapterCommand = config.adapterCommand || null;
    this.adapterArgs = config.adapterArgs || [];
    this.npxPackage = config.npxPackage || null;
    this.spawnEnv = config.spawnEnv || {};
  }

  defaultBuildArgs(prompt, config) { return []; }

  defaultParseOutput(line) {
    try { return JSON.parse(line); } catch { return null; }
  }

  async run(prompt, cwd, config = {}) {
    if (this.protocol === 'acp' && this.protocolHandler) return this.runACP(prompt, cwd, config);
    return this.runDirect(prompt, cwd, config);
  }
}
