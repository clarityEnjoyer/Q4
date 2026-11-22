import { useMemo, useState } from 'preact/hooks';
import { verifySemilatticeLaws } from '../core/crdt';
import { addTask, BoronAnalytics } from '../core/engine';
import { parseMarkdownTaskLines, serializeToMarkdown } from '../core/markdown';
import { AppState, GistSyncConfig, Quadrant } from '../core/types';
import { downloadTextFile } from '../sync/storage';
import { DensityMode, THEME_REGISTRY } from '../visuals/themes';

export interface SyncLabViewProps {
  state: AppState;
  analytics: BoronAnalytics;
  gistConfig: GistSyncConfig;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error';
  syncMessage: string;
  onUpdateGistConfig: (updater: (prev: GistSyncConfig) => GistSyncConfig) => void;
  onSyncGist: () => void;
  onCreateSecretGist: () => void;
  onDisconnectToken: () => void;
  onImportTasks: (
    items: Array<{ title: string; quadrant: Quadrant; completed: boolean }>
  ) => void;
  isMobile?: boolean;
  visualPrefs?: { themeId: string; density: DensityMode };
  onUpdateVisualPrefs?: (
    updater: (prev: { themeId: string; density: DensityMode }) => {
      themeId: string;
      density: DensityMode;
    }
  ) => void;
}

export function SyncLabView({
  state,
  analytics,
  gistConfig,
  syncStatus,
  syncMessage,
  onUpdateGistConfig,
  onSyncGist,
  onCreateSecretGist,
  onDisconnectToken,
  onImportTasks,
  isMobile,
  visualPrefs,
  onUpdateVisualPrefs,
}: SyncLabViewProps) {
  const [showMarkdownBox, setShowMarkdownBox] = useState(false);
  const [importMarkdownText, setImportMarkdownText] = useState('');
  const [showGuide, setShowGuide] = useState(!isMobile);
  const [showProof, setShowProof] = useState(false);

  const semilatticeProof = useMemo(() => {
    if (!showProof) return null;
    const replicaLaptop = addTask(
      { ...state, nodeId: 'laptop_mimuw' },
      'Simulated offline laptop edit #q2'
    );
    const replicaPhone = addTask(
      { ...state, nodeId: 'phone_metro' },
      'Simulated offline phone edit #q3'
    );
    return verifySemilatticeLaws(state, replicaLaptop, replicaPhone);
  }, [showProof, state]);

  return (
    <div class="panel-grid">
      <div class="panel-card">
        <h3>GitHub Gist CRDT Sync</h3>
        <div class="form-group">
          <label>GitHub Personal Access Token</label>
          <input
            type="password"
            class="capture-input"
            placeholder="ghp_... or github_pat_..."
            value={gistConfig.token}
            onInput={(e) =>
              onUpdateGistConfig((prev) => ({
                ...prev,
                token: (e.target as HTMLInputElement).value,
              }))
            }
          />
        </div>

        <div class="form-group">
          <label>Secret Gist ID</label>
          <input
            type="text"
            class="capture-input mono"
            placeholder="Leave blank on first device, then click Create Secret Gist"
            value={gistConfig.gistId}
            onInput={(e) =>
              onUpdateGistConfig((prev) => ({
                ...prev,
                gistId: (e.target as HTMLInputElement).value,
              }))
            }
          />
        </div>

        <div class="form-group">
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              cursor: 'pointer',
              fontSize: '0.82rem',
            }}
          >
            <input
              type="checkbox"
              checked={gistConfig.autoSync}
              onChange={(e) =>
                onUpdateGistConfig((prev) => ({
                  ...prev,
                  autoSync: (e.target as HTMLInputElement).checked,
                }))
              }
            />
            Automatic background sync (changes, reconnect, tab focus)
          </label>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            class="btn btn-primary"
            disabled={syncStatus === 'syncing' || !gistConfig.token.trim()}
            onClick={onSyncGist}
          >
            Sync Now (local ⊔ remote)
          </button>
          <button
            type="button"
            class="btn btn-q2"
            disabled={syncStatus === 'syncing' || !gistConfig.token.trim()}
            onClick={onCreateSecretGist}
          >
            Create Secret Gist
          </button>
          <button
            type="button"
            class="btn btn-sm"
            onClick={onDisconnectToken}
          >
            Disconnect Token
          </button>
        </div>

        {syncMessage && (
          <div
            class="pill"
            style={{
              borderRadius: '8px',
              whiteSpace: 'normal',
              borderColor:
                syncStatus === 'error' ? 'var(--q1-color)' : 'var(--q2-color)',
            }}
          >
            {syncMessage}
          </div>
        )}

        {/* Compact Optional Markdown Bar */}
        <div
          style={{
            marginTop: '0.35rem',
            paddingTop: '0.65rem',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.4rem',
          }}
        >
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Export / Backup:
          </span>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() =>
                navigator.clipboard?.writeText(serializeToMarkdown(state))
              }
            >
              Copy MD
            </button>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() =>
                downloadTextFile(
                  'Q4-MATRIX.md',
                  serializeToMarkdown(state),
                  'text/markdown'
                )
              }
            >
              .MD
            </button>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() =>
                downloadTextFile(
                  'q4-state.json',
                  JSON.stringify(state, null, 2),
                  'application/json'
                )
              }
            >
              .JSON
            </button>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => setShowMarkdownBox((v) => !v)}
            >
              {showMarkdownBox ? 'Hide MD' : 'View / Import MD'}
            </button>
          </div>
        </div>

        {showMarkdownBox && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <pre class="code-preview mono" style={{ maxHeight: '140px' }}>
              {serializeToMarkdown(state)}
            </pre>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <input
                type="text"
                class="capture-input"
                style={{ padding: '0.35rem 0.6rem' }}
                placeholder="- [ ] Task title #q2"
                value={importMarkdownText}
                onInput={(e) =>
                  setImportMarkdownText((e.target as HTMLInputElement).value)
                }
              />
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => {
                  const parsed = parseMarkdownTaskLines(importMarkdownText);
                  if (parsed.length > 0) {
                    onImportTasks(parsed);
                    setImportMarkdownText('');
                  }
                }}
              >
                Import
              </button>
            </div>
          </div>
        )}
      </div>

      {isMobile && visualPrefs && onUpdateVisualPrefs && (
        <div class="panel-card">
          <h3>Appearance</h3>
          <div class="form-group">
            <label for="mobile-theme-select">Theme</label>
            <select
              id="mobile-theme-select"
              class="capture-select"
              value={visualPrefs.themeId}
              onChange={(e) =>
                onUpdateVisualPrefs((prev) => ({
                  ...prev,
                  themeId: (e.currentTarget as HTMLSelectElement).value,
                }))
              }
            >
              {THEME_REGISTRY.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.label}
                </option>
              ))}
            </select>
          </div>
          <div class="form-group">
            <label>Layout Density</label>
            <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                class={`btn btn-sm ${
                  visualPrefs.density === 'comfortable' ? 'btn-primary' : ''
                }`}
                onClick={() =>
                  onUpdateVisualPrefs((prev) => ({ ...prev, density: 'comfortable' }))
                }
              >
                Comfortable
              </button>
              <button
                type="button"
                class={`btn btn-sm ${visualPrefs.density === 'compact' ? 'btn-primary' : ''}`}
                onClick={() =>
                  onUpdateVisualPrefs((prev) => ({ ...prev, density: 'compact' }))
                }
              >
                Compact
              </button>
            </div>
          </div>
        </div>
      )}

      <div class="panel-card">
        <div class="panel-header-row">
          <h3>Setup Guide & CRDT Sync</h3>
          <button
            type="button"
            class="btn btn-sm disclosure-btn"
            aria-expanded={showGuide}
            onClick={() => setShowGuide((v) => !v)}
          >
            {showGuide ? 'Hide Guide' : 'Show Guide'}
          </button>
        </div>

        {showGuide && (
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.55rem',
            }}
          >
            <div>
              <strong style={{ color: 'var(--text-main)' }}>
                1. Create a GitHub Token (Fix Error 403)
              </strong>
              <div>
                • Open GitHub <code>Settings → Developer settings → Personal access tokens</code>.
              </div>
              <div>
                • <strong>Classic token (easiest):</strong> Click <code>Generate new token (classic)</code>. Check the <code>gist</code> box.
              </div>
              <div>
                • <strong>Fine-grained token:</strong> Open <code>Account permissions</code> (not Repository permissions). Set <code>Gists</code> to <code>Read and write</code>.
              </div>
            </div>

            <div>
              <strong style={{ color: 'var(--text-main)' }}>
                2. Initialize the Gist on Your Laptop
              </strong>
              <div>
                • Paste your token into the token field. Leave <code>Secret Gist ID</code> blank.
              </div>
              <div>
                • Click <code>Create Secret Gist</code>. Copy the generated Gist ID.
              </div>
            </div>

            <div>
              <strong style={{ color: 'var(--text-main)' }}>
                3. Open the App on Your Phone (Network Setup)
              </strong>
              <div>
                • <strong>Same Wi-Fi:</strong> Run <code>npm run dev</code> on your laptop. Open the <code>Network: http://192.168.x.x:5173</code> URL printed in your terminal on your phone.
              </div>
              <div>
                • <strong>Anywhere (Mobile Data):</strong> Run <code>npm run build</code> and upload the <code>dist/</code> folder to GitHub Pages, Cloudflare Pages, or Vercel.
              </div>
              <div>
                • On your phone, paste the same Token and Secret Gist ID, then click <code>Sync Now</code>.
              </div>
            </div>
          </div>
        )}

        <div class="panel-header-row">
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Node: <code class="mono">{state.nodeId}</code> · Lamport:{' '}
            <code class="mono">{state.maxLamport}</code> · Q2 Ratio:{' '}
            <code class="mono">{analytics.q2CompletionRatio}%</code>
          </span>
          <button
            type="button"
            class="btn btn-sm disclosure-btn"
            aria-expanded={showProof}
            onClick={() => setShowProof((v) => !v)}
          >
            {showProof ? 'Hide Proof' : 'Verify CRDT'}
          </button>
        </div>

        {showProof && semilatticeProof && (
          <div class="code-preview mono" style={{ padding: '0.55rem 0.7rem' }}>
            {semilatticeProof.details.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
