/**
 * The abstraction boundary between "provision/manage an isolated OpenClaw
 * instance for one tenant" and "how that isolation is actually
 * implemented." Exists because real-environment verification (this
 * session, 2026-08-22) found `openclaw fleet` - the mechanism this
 * platform was originally built around - does not exist in any released,
 * stable OpenClaw version; it is unreleased work living only in
 * OpenClaw's own beta line, which this platform will never deploy on
 * (see CHANGELOG_SECURITY.md's "OpenClaw Cell Runtime" entry for the
 * full verification trail).
 *
 * `DockerCellRuntime` is the real implementation for right now: it does
 * directly, by hand, what Fleet was going to automate for us (create a
 * hardened container per tenant, running `openclaw gateway`, with its
 * own network/state/token). A future `FleetCellRuntime` implementing
 * this exact same interface can replace it once OpenClaw ships Fleet in
 * a real stable release - deliberately not built now, since building an
 * implementation against a CLI command that doesn't exist yet would be
 * exactly the kind of speculative code this codebase's own governing
 * principle warns against.
 */
export interface CellCreateResult {
  containerId: string;
  gatewayEndpoint: string;
  port: number;
}

export type CellRuntimeState = 'running' | 'stopped' | 'unknown';

export interface CellStatus {
  state: CellRuntimeState;
  healthy: boolean;
}

export interface OpenClawCellRuntime {
  /** Short, human-readable name for logging/diagnostics - e.g. "docker", "fleet" (once real). */
  readonly name: string;

  /**
   * Creates and starts a new isolated instance for `cellId`. `env` is
   * passed into the instance's own environment (must include whatever
   * credential the instance needs to authenticate itself, e.g. a
   * Gateway token) - implementations must never log or echo `env` values
   * back, since they are secret-bearing.
   */
  create(cellId: string, image: string, env: Record<string, string>): Promise<CellCreateResult>;

  status(cellId: string): Promise<CellStatus>;
  stop(cellId: string): Promise<void>;
  start(cellId: string): Promise<void>;

  /** Replaces the running instance with one built from `image`, preserving state. Returns the new instance's connection info. */
  upgrade(cellId: string, image: string): Promise<CellCreateResult>;

  remove(cellId: string, options: { purgeData: boolean }): Promise<void>;
}
