import type {
  AgentBackendKind,
  ApprovalRequest,
  ApprovalResolution,
  CapabilityProfile,
  ConfuciusEvent,
  RuntimeStatus,
  SessionMode,
} from "@confucius/protocol";

export interface RuntimeMcpConfig {
  url: string;
  token: string;
}

export interface RuntimeTurnInput {
  taskId: string;
  turnId: string;
  prompt: string;
  mode: SessionMode;
  capabilityProfile: CapabilityProfile;
  cwd: string;
  externalSessionId?: string;
  mcp: RuntimeMcpConfig;
  developerInstructions: string;
}

export interface RuntimeTurnHandle {
  externalSessionId: string;
  externalTurnId?: string;
}

export interface RuntimeEventSink {
  emit<T extends ConfuciusEvent["type"]>(
    type: T,
    payload: Extract<ConfuciusEvent, { type: T }>["payload"],
    turnId?: string,
  ): void;
}

export interface ApprovalBrokerLike {
  request(request: ApprovalRequest): Promise<ApprovalResolution>;
}

export interface RuntimeAdapter {
  readonly kind: Exclude<AgentBackendKind, "native">;
  probe(): Promise<RuntimeStatus>;
  startTurn(
    input: RuntimeTurnInput,
    sink: RuntimeEventSink,
    approvals: ApprovalBrokerLike,
  ): Promise<RuntimeTurnHandle>;
  interrupt(taskId: string): Promise<void>;
  dispose(taskId: string): Promise<void>;
  analyze?(prompt: string, cwd: string): Promise<string>;
}

export interface SidecarDescriptor {
  protocol: 1;
  pid: number;
  baseUrl: string;
  token: string;
  version: string;
  startedAt: number;
}

export interface HostRegistration {
  baseUrl: string;
  pairingToken: string;
  registeredAt: number;
}
