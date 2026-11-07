import { mergeAppState } from '../core/crdt';
import { serializeToMarkdown } from '../core/markdown';
import { AppState, GistSyncConfig } from '../core/types';

const STATE_FILENAME = 'q4-state.json';
const MARKDOWN_FILENAME = 'Q4-MATRIX.md';

export interface SyncOutcome {
  mergedState: AppState;
  gistId: string;
  gistHtmlUrl?: string;
  syncedAt: number;
}

function formatGitHubError(status: number, errText: string, statusText: string): string {
  if (status === 403) {
    return 'GitHub 403 Forbidden: Your token does not have Gist write permission. For a Classic token, check "gist". For a Fine-grained token, open Account permissions -> Gists -> select "Read and write".';
  }
  if (status === 401) {
    return 'GitHub 401 Unauthorized: Your token is invalid or expired.';
  }
  if (status === 404) {
    return 'GitHub 404 Not Found: Check that your Secret Gist ID is correct and that your token has Gist access.';
  }
  return `GitHub API Error (${status}): ${errText || statusText}`;
}

export async function createNewSecretGist(
  token: string,
  localState: AppState
): Promise<SyncOutcome> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error('Enter a GitHub Personal Access Token first.');
  }

  const syncedAt = Date.now();
  const stateToUpload: AppState = {
    ...localState,
    lastSyncedAt: syncedAt,
  };

  const markdownContent = serializeToMarkdown(stateToUpload, new Date(syncedAt));
  const jsonContent = JSON.stringify(stateToUpload, null, 2);

  const response = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cleanToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: 'Boron Q4 Matrix — Local-First CRDT Task State',
      public: false,
      files: {
        [MARKDOWN_FILENAME]: { content: markdownContent },
        [STATE_FILENAME]: { content: jsonContent },
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(formatGitHubError(response.status, errText, response.statusText));
  }

  const data = await response.json();
  return {
    mergedState: stateToUpload,
    gistId: data.id,
    gistHtmlUrl: data.html_url,
    syncedAt,
  };
}

export async function syncWithGitHubGist(
  config: GistSyncConfig,
  localState: AppState
): Promise<SyncOutcome> {
  const cleanToken = config.token.trim();
  const cleanGistId = config.gistId.trim();

  if (!cleanToken) {
    throw new Error('Enter your GitHub Personal Access Token.');
  }
  if (!cleanGistId) {
    throw new Error('Enter a Gist ID, or click "Create Secret Gist" first.');
  }

  const getRes = await fetch(`https://api.github.com/gists/${cleanGistId}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cleanToken}`,
    },
  });

  if (!getRes.ok) {
    const errText = await getRes.text().catch(() => '');
    throw new Error(formatGitHubError(getRes.status, errText, getRes.statusText));
  }

  const gistData = await getRes.json();
  const remoteStateFile = gistData.files?.[STATE_FILENAME];

  let mergedState = localState;
  if (remoteStateFile && remoteStateFile.content) {
    try {
      const remoteState = JSON.parse(remoteStateFile.content) as AppState;
      mergedState = mergeAppState(localState, remoteState);
    } catch (parseErr) {
      console.warn('Could not parse remote q4-state.json, using local state:', parseErr);
    }
  }

  const syncedAt = Date.now();
  const finalState: AppState = {
    ...mergedState,
    lastSyncedAt: syncedAt,
  };

  const markdownContent = serializeToMarkdown(finalState, new Date(syncedAt));
  const jsonContent = JSON.stringify(finalState, null, 2);

  const patchRes = await fetch(`https://api.github.com/gists/${cleanGistId}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cleanToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [MARKDOWN_FILENAME]: { content: markdownContent },
        [STATE_FILENAME]: { content: jsonContent },
      },
    }),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    throw new Error(formatGitHubError(patchRes.status, errText, patchRes.statusText));
  }

  const updatedGist = await patchRes.json();
  return {
    mergedState: finalState,
    gistId: updatedGist.id,
    gistHtmlUrl: updatedGist.html_url,
    syncedAt,
  };
}
