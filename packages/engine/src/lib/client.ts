/**
 * Library entry: "@alignlabs/sofar/client" (sync-client 4.2, SPEC §Sync
 * client).
 *
 * The v2 sync client as an importable surface — the Tauri shell and the iOS
 * app drive the same code the CLI does: RFC-8628 device login, repo link,
 * push/pull over the cursor primitive, and the doorbell SSE subscription.
 * Pure re-exports of src/client/*: importing this module executes no CLI
 * code and has no side effects (config/env/fs access happens at call time,
 * never at import time). Zero runtime dependencies — native fetch only.
 */

export {
  API_URL_ENV,
  credentialsPath,
  DEFAULT_API_URL,
  normalizeApiUrl,
  readCredential,
  readRemote,
  readSyncState,
  remotePath,
  resolveApiUrl,
  syncStatePath,
  writeCredential,
  writeRemote,
  writeSyncState,
  type Env,
  type RemoteConfig,
  type StoredCredential,
  type StreamCursors,
  type SyncState,
} from '../client/config'

export {
  ApiError,
  apiJson,
  apiRequest,
  defaultSleep,
  errorParts,
  isRetryable,
  parseRetryAfter,
  toApiError,
  withRetries,
  type FetchLike,
  type RequestOptions,
  type RetryPolicy,
  type Sleep,
} from '../client/http'

export {
  DEVICE_CLIENT_ID,
  deviceLogin,
  DeviceFlowError,
  mintToken,
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCodeResponse,
  type DeviceFlowOptions,
  type DeviceLoginOptions,
  type MintedToken,
  type MintTokenOptions,
  type PollOptions,
} from '../client/device'

export { createRepo, type CreateRepoOptions } from '../client/repos'

export {
  eventsPathFor,
  MAX_BATCH_BYTES,
  MAX_BATCH_LINES,
  pushStream,
  splitBatches,
  type InvalidLine,
  type PushBatch,
  type PushReport,
  type PushResponse,
  type PushStreamOptions,
} from '../client/push'

export {
  CURSOR_HEADER,
  DEFAULT_PULL_LIMIT,
  pullStream,
  type PullReport,
  type PullStreamOptions,
} from '../client/pull'

export {
  doorbellPath,
  runDoorbell,
  type DoorbellOptions,
  type DoorbellRing,
} from '../client/doorbell'
