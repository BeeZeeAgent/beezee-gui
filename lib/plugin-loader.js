import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

class PluginLoader extends EventEmitter {
  constructor(pluginDir) {
    super();
    this.pluginDir = pluginDir;
    this.registry = new Map();
    this.instances = new Map();
    this.states = new Map();
    this.watchers = new Map();
    this.errorCounts = new Map();
    this.fileMap = new Map();
  }

  async loadPlugin(fileName) {
    const filePath = path.join(this.pluginDir, `${fileName}.js`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Plugin file not found: ${filePath}`);
    }
    const fileUrl = `file://${filePath}?v=${Date.now()}`;
    try {
      const plugin = await import(fileUrl);
      const mod = plugin.default || plugin;
      const regName = mod.name || fileName;
      this.registry.set(regName, mod);
      this.fileMap.set(regName, fileName);
      return mod;
    } catch (error) {
      console.error(`Failed to load plugin ${fileName}:`, error.message);
      throw error;
    }
  }

  async initializePlugin(name, config) {
    const plugin = this.registry.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found in registry`);
    }
    if (this.instances.has(name)) {
      return this.instances.get(name);
    }
    for (const depName of (plugin.dependencies || [])) {
      if (!this.instances.has(depName)) {
        await this.initializePlugin(depName, config);
      }
    }
    try {
      const result = await plugin.init(config, this.instances);
      this.instances.set(name, result);
      return result;
    } catch (error) {
      console.error(`[PluginLoader] Error initializing ${name}:`, error.message);
      throw error;
    }
  }

  get(name) {
    return this.instances.get(name);
  }

  async reloadPlugin(name) {
    const plugin = this.registry.get(name);
    if (!plugin) {
      console.warn(`[PluginLoader] Cannot reload ${name}: not found`);
      return;
    }
    const state = this.instances.get(name);
    if (!state) {
      console.warn(`[PluginLoader] Cannot reload ${name}: not initialized`);
      return;
    }
    try {
      if (state.stop) await state.stop();
      const fileName = this.fileMap.get(name) || name;
      await this.loadPlugin(fileName);
      const reloadedPlugin = this.registry.get(name);
      const newState = await reloadedPlugin.reload(state);
      this.instances.set(name, newState);
      this.emit('reload', { name, success: true });
      console.log(`[PluginLoader] Reloaded plugin: ${name}`);
    } catch (error) {
      console.error(`[PluginLoader] Error reloading ${name}:`, error.message);
      this.emit('reload', { name, success: false, error: error.message });
    }
  }

  watchPlugin(name, callback) {
    const fileName = this.fileMap.get(name) || name;
    const filePath = path.join(this.pluginDir, `${fileName}.js`);
    if (this.watchers.has(name)) return;
    const watcher = fs.watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => callback(name), 100);
      }
    });
    this.watchers.set(name, watcher);
  }

  unwatchPlugin(name) {
    const watcher = this.watchers.get(name);
    if (watcher) {
      watcher.close();
      this.watchers.delete(name);
    }
  }

  async loadAllPlugins(config) {
    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
      return;
    }
    const files = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const fileName = file.replace('.js', '');
      try {
        await this.loadPlugin(fileName);
      } catch (error) {
        console.error(`[PluginLoader] Failed to load ${fileName}:`, error.message);
      }
    }
    const sorted = this.topologicalSort();
    for (const name of sorted) {
      try {
        await this.initializePlugin(name, config);
      } catch (error) {
        console.error(`[PluginLoader] Failed to initialize ${name}:`, error.message);
      }
    }
  }

  topologicalSort() {
    const visited = new Set(), result = [];
    const visit = (name) => {
      if (visited.has(name)) return;
      visited.add(name);
      for (const dep of (this.registry.get(name)?.dependencies || [])) { if (this.registry.has(dep)) visit(dep); }
      result.push(name);
    };
    for (const name of this.registry.keys()) visit(name);
    return result;
  }

  async shutdown() {
    const sorted = this.topologicalSort().reverse();
    for (const name of sorted) {
      const state = this.instances.get(name);
      if (state && state.stop) {
        try {
          await state.stop();
        } catch (error) {
          console.error(`[PluginLoader] Error stopping ${name}:`, error.message);
        }
      }
      this.unwatchPlugin(name);
    }
    this.instances.clear();
    this.registry.clear();
  }
}
export default PluginLoader;
