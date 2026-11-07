import { createStarterState, escalateNeglectedQ2Tasks } from '../core/engine';
import { AppState, GistSyncConfig } from '../core/types';

const STATE_STORAGE_KEY = 'boron_q4_crdt_state_v1';
const NODE_ID_KEY = 'boron_q4_node_id_v1';
const GIST_CONFIG_KEY = 'boron_q4_gist_config_v1';

export function getOrCreateNodeId(): string {
  try {
    const existing = localStorage.getItem(NODE_ID_KEY);
    if (existing) return existing;
    const created =
      'node_' +
      Math.random().toString(36).substring(2, 7) +
      '_' +
      Date.now().toString(36).slice(-4);
    localStorage.setItem(NODE_ID_KEY, created);
    return created;
  } catch {
    return 'node_ephemeral';
  }
}

export function loadLocalState(): AppState {
  const nodeId = getOrCreateNodeId();
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) {
      const starter = createStarterState(nodeId);
      saveLocalState(starter);
      return starter;
    }
    const parsed = JSON.parse(raw) as AppState;
    parsed.nodeId = nodeId;
    const { state: escalatedState, escalatedCount } = escalateNeglectedQ2Tasks(parsed);
    if (escalatedCount > 0) {
      saveLocalState(escalatedState);
    }
    return escalatedState;
  } catch {
    return createStarterState(nodeId);
  }
}

export function saveLocalState(state: AppState): void {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Failed to save state to localStorage:', err);
  }
}

export function loadGistConfig(): GistSyncConfig {
  try {
    const raw = localStorage.getItem(GIST_CONFIG_KEY);
    if (!raw) {
      return { token: '', gistId: '', autoSync: true };
    }
    return JSON.parse(raw) as GistSyncConfig;
  } catch {
    return { token: '', gistId: '', autoSync: true };
  }
}

export function saveGistConfig(config: GistSyncConfig): void {
  try {
    localStorage.setItem(GIST_CONFIG_KEY, JSON.stringify(config));
  } catch (err) {
    console.error('Failed to save Gist config:', err);
  }
}

export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

