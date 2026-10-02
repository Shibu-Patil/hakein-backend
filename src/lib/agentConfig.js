import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { AIProviderFactory } from '../services/aiProviders.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cached = null;

export function loadAgentConfig() {
  if (cached) return cached;
  const path = join(ROOT, 'agent.yaml');
  if (!existsSync(path)) {
    cached = { active: 'gemini', agents: {}, tasks: {} };
    return cached;
  }
  cached = YAML.parse(readFileSync(path, 'utf8')) || {};
  cached.agents = cached.agents || {};
  cached.tasks = cached.tasks || {};
  if (!cached.active) cached.active = Object.keys(cached.agents)[0] || 'gemini';
  return cached;
}

export function reloadAgentConfig() {
  cached = null;
  return loadAgentConfig();
}

// Resolve a named agent (or active default) to { name, provider, model, apiKey }.
// Keys come ONLY from env (via apiKeyEnv). Inline keys in yaml are not supported.
export function resolveAgent(name) {
  const cfg = loadAgentConfig();
  const agentName = name || cfg.active;
  const entry = cfg.agents[agentName];
  if (!entry) throw new Error(`Unknown agent "${agentName}". Choices: ${Object.keys(cfg.agents).join(', ') || '(none)'}`);
  if (!entry.provider || !entry.apiKeyEnv) {
    throw new Error(`Agent "${agentName}" must set provider + apiKeyEnv in agent.yaml`);
  }
  const apiKey = process.env[entry.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Agent "${agentName}" needs ${entry.apiKeyEnv} set in .env`);
  }
  return { name: agentName, provider: entry.provider, model: entry.model, apiKey };
}

// Agent chosen for a task (resume | qa | scoring), else the active one.
export function agentForTask(task) {
  const cfg = loadAgentConfig();
  return resolveAgent((task && cfg.tasks[task]) || cfg.active);
}

// Server default AI instance (task-aware). Throws a clear error when unconfigured.
export function defaultAI(task) {
  const { provider, model, apiKey } = agentForTask(task);
  return AIProviderFactory.create(provider, apiKey, model);
}

// Safe listing for UI/docs — no keys.
export function listAgents() {
  const cfg = loadAgentConfig();
  return {
    active: cfg.active,
    tasks: cfg.tasks,
    agents: Object.fromEntries(
      Object.entries(cfg.agents).map(([name, e]) => [
        name,
        {
          provider: e.provider,
          model: e.model,
          keyConfigured: !!(e.apiKeyEnv && process.env[e.apiKeyEnv])
        }
      ])
    )
  };
}
