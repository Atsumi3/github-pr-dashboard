import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || '/app/data/config.json';

const DEFAULT_CONFIG = {
  repos: [],
  settings: {
    pollInterval: 60,
  },
};

let configCache = null;
let reposVersion = 0;

export function getReposVersion() {
  return reposVersion;
}

async function load() {
  if (configCache) return configCache;
  try {
    const data = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    // Migration: drop legacy `auth` field if present in existing config files
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'auth')) {
      delete parsed.auth;
    }
    configCache = {
      repos: parsed.repos || [],
      settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) },
    };
  } catch {
    configCache = structuredClone(DEFAULT_CONFIG);
  }
  return configCache;
}

async function save(config) {
  configCache = config;
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export async function getRepos() {
  const config = await load();
  return config.repos;
}

export async function addRepo(id) {
  const config = await load();
  if (config.repos.some((r) => r.id === id)) {
    return null;
  }
  const repo = { id, addedAt: new Date().toISOString() };
  config.repos.push(repo);
  await save(config);
  reposVersion++;
  return repo;
}

export async function removeRepo(id) {
  const config = await load();
  const before = config.repos.length;
  config.repos = config.repos.filter((r) => r.id !== id);
  if (config.repos.length === before) return false;
  await save(config);
  reposVersion++;
  return true;
}

export async function setRepoPaused(id, paused) {
  const config = await load();
  const repo = config.repos.find((r) => r.id === id);
  if (!repo) return false;
  repo.paused = !!paused;
  await save(config);
  reposVersion++;
  return true;
}

export async function getSettings() {
  const config = await load();
  return config.settings;
}

export async function updateSettings(settings) {
  const config = await load();
  config.settings = { ...config.settings, ...settings };
  await save(config);
  return config.settings;
}
