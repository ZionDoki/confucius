import type {
  AgentBackendKind,
  ApprovalRequest,
  ApprovalResolution,
  CapabilityProfile,
  ConfuciusEvent,
  RuntimeStatus,
  RuntimeAnalysisOptions,
  RuntimeModelSelection,
  SessionMode,
} from "@confucius/protocol";

export interface PluginRuntimeMcpConfig {
  url: string;
  token: string;
}

export interface PluginRuntimeTurnInput {
  taskId: string;
  /** Internal session identity allows a candidate to coexist with its predecessor. */
  sessionKey?: string;
  prepareOnly?: boolean;
  turnId: string;
  prompt: string;
  mode: SessionMode;
  capabilityProfile: CapabilityProfile;
  cwd: string;
  externalSessionId?: string;
  runtimeModel?: RuntimeModelSelection;
  mcp: PluginRuntimeMcpConfig;
  developerInstructions: string;
}

export interface PluginRuntimeTurnHandle {
  externalSessionId: string;
  externalTurnId?: string;
  /** Selection confirmed by the runtime after resolving model-specific aliases. */
  runtimeModel?: RuntimeModelSelection;
}

export interface PluginRuntimeEventSink {
  emit<T extends ConfuciusEvent["type"]>(
    type: T,
    payload: Extract<ConfuciusEvent, { type: T }>["payload"],
    turnId?: string,
  ): void;
}

export interface PluginApprovalBrokerLike {
  request(request: ApprovalRequest): Promise<ApprovalResolution>;
}

export interface PluginRuntimeAdapter {
  readonly kind: Exclude<AgentBackendKind, "native">;
  probe(modelId?: string): Promise<RuntimeStatus>;
  configure?(executable?: string): void;
  startTurn(
    input: PluginRuntimeTurnInput,
    sink: PluginRuntimeEventSink,
    approvals: PluginApprovalBrokerLike,
  ): Promise<PluginRuntimeTurnHandle>;
  interrupt(taskId: string): Promise<void>;
  dispose(taskId: string): Promise<void>;
  analyze?(
    prompt: string,
    cwd: string,
    selection?: RuntimeModelSelection,
    options?: RuntimeAnalysisOptions,
    signal?: AbortSignal,
  ): Promise<string>;
}
