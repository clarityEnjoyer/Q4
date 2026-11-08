import { AppState } from '../core/types';

export interface SyncOutcome {
  mergedState: AppState;
  remoteId: string;
  remoteUrl?: string;
  syncedAt: number;
  pushedChanges: boolean;
  fromCache?: boolean;
}

export interface SyncAdapter<TConfig> {
  id: string;
  name: string;
  isConfigured(config: TConfig): boolean;
  sync(config: TConfig, localState: AppState): Promise<SyncOutcome>;
}
