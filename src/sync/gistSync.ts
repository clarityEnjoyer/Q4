import { canonicalStateSignature, mergeAppState } from '../core/crdt';
import { serializeToMarkdown } from '../core/markdown';
import { AppState, GistSyncConfig } from '../core/types';
import { isValidAppState } from './storage';
import { SyncAdapter, SyncOutcome as CoreSyncOutcome } from './types';

const STATE_FILENAME = 'q4-state.json';
const MARKDOWN_FILENAME = 'Q4-MATRIX.md';

export interface SyncOutcome {
  mergedState: AppState;
  gistId: string;
  gistHtmlUrl?: string;
  syncedAt: number;
  pushedChanges?: boolean;
  fromCache?: boolean;
  remoteId?: string;
  remoteUrl?: string;
}

export interface GistCacheEntry {
  etag: string;
  remoteState: AppState;
  htmlUrl?: string;
}

export const gistCache: Record<string, GistCacheEntry> = {};

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
  const etag = response.headers.get('ETag') || '';
  if (data.id) {
    gistCache[data.id] = {
      etag,
      remoteState: stateToUpload,
      htmlUrl: data.html_url,
    };
  }

  return {
    mergedState: stateToUpload,
    gistId: data.id,
    gistHtmlUrl: data.html_url,
    syncedAt,
    pushedChanges: true,
    fromCache: false,
    remoteId: data.id,
    remoteUrl: data.html_url,
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

  const cached = gistCache[cleanGistId];
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cleanToken}`,
  };

  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  const getRes = await fetch(`https://api.github.com/gists/${cleanGistId}`, {
    method: 'GET',
    headers,
  });

  if (getRes.status !== 304 && !getRes.ok) {
    const errText = await getRes.text().catch(() => '');
    throw new Error(formatGitHubError(getRes.status, errText, getRes.statusText));
  }

  let remoteState: AppState | null = null;
  let remoteStateFileExisted = false;

  if (getRes.status === 304 && cached) {
    remoteState = cached.remoteState;
    remoteStateFileExisted = true;
  } else if (getRes.status === 200) {
    const gistData = await getRes.json();
    const remoteStateFile = gistData.files?.[STATE_FILENAME];

    if (remoteStateFile) {
      remoteStateFileExisted = true;
      if (remoteStateFile.content) {
        try {
          const parsed = JSON.parse(remoteStateFile.content);
          if (isValidAppState(parsed)) {
            remoteState = parsed;
            const etag = getRes.headers.get('ETag') || '';
            gistCache[cleanGistId] = {
              etag,
              remoteState,
              htmlUrl: gistData.html_url,
            };
          } else {
            console.warn('Remote q4-state.json failed validation, using local state.');
          }
        } catch (parseErr) {
          console.warn('Could not parse remote q4-state.json, using local state:', parseErr);
        }
      }
    }
  }

  let mergedState = localState;
  if (remoteState) {
    mergedState = mergeAppState(localState, remoteState);
  }

  if (
    remoteStateFileExisted &&
    remoteState &&
    canonicalStateSignature(mergedState) === canonicalStateSignature(remoteState)
  ) {
    const now = Date.now();
    return {
      mergedState: {
        ...mergedState,
        lastSyncedAt: now,
      },
      gistId: cleanGistId,
      gistHtmlUrl: gistCache[cleanGistId]?.htmlUrl || cached?.htmlUrl,
      syncedAt: now,
      pushedChanges: false,
      fromCache: getRes.status === 304,
      remoteId: cleanGistId,
      remoteUrl: gistCache[cleanGistId]?.htmlUrl || cached?.htmlUrl,
    };
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
  const patchEtag = patchRes.headers.get('ETag') || gistCache[cleanGistId]?.etag || '';
  gistCache[cleanGistId] = {
    etag: patchEtag,
    remoteState: finalState,
    htmlUrl: updatedGist.html_url || gistCache[cleanGistId]?.htmlUrl,
  };

  return {
    mergedState: finalState,
    gistId: updatedGist.id || cleanGistId,
    gistHtmlUrl: updatedGist.html_url || gistCache[cleanGistId]?.htmlUrl,
    syncedAt,
    pushedChanges: true,
    fromCache: false,
    remoteId: updatedGist.id || cleanGistId,
    remoteUrl: updatedGist.html_url || gistCache[cleanGistId]?.htmlUrl,
  };
}

export const gistSyncAdapter: SyncAdapter<GistSyncConfig> = {
  id: 'github-gist',
  name: 'GitHub Gist',
  isConfigured(config: GistSyncConfig): boolean {
    return Boolean(config?.token?.trim() && config?.gistId?.trim());
  },
  async sync(config: GistSyncConfig, localState: AppState): Promise<CoreSyncOutcome> {
    const outcome = await syncWithGitHubGist(config, localState);
    return {
      mergedState: outcome.mergedState,
      remoteId: outcome.gistId,
      remoteUrl: outcome.gistHtmlUrl,
      syncedAt: outcome.syncedAt,
      pushedChanges: outcome.pushedChanges ?? false,
      fromCache: outcome.fromCache,
    };
  },
};
