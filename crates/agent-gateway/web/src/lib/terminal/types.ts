export type TerminalSession = {
  id: string;
  projectPathKey: string;
  cwd: string;
  shell: string;
  title: string;
  kind: "local" | "ssh";
  ssh?: TerminalSshMetadata | null;
  pid?: number | null;
  cols: number;
  rows: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  exitCode?: number | null;
  running: boolean;
};

export type TerminalSshMetadata = {
  hostId: string;
  hostName: string;
  username: string;
  host: string;
  port: number;
  authType: string;
  status: "connected" | "reconnecting" | "disconnected" | string;
  reconnectAttempt: number;
  reconnectMaxAttempts: number;
};

export type TerminalSshPrompt = {
  id: string;
  kind: "hostKey" | "auth" | string;
  hostId: string;
  hostName: string;
  host: string;
  port: number;
  message: string;
  fingerprintSha256?: string;
  keyType?: string;
  answerEcho?: boolean;
};

export type TerminalSnapshot = {
  session: TerminalSession;
  output: string;
  truncated: boolean;
  outputStartOffset?: number;
  outputEndOffset?: number;
};

export type TerminalSshCreateResult = {
  snapshot?: TerminalSnapshot;
  prompt?: TerminalSshPrompt;
};

export type TerminalSshLatency = {
  sessionId: string;
  latencyMs: number;
};

export type TerminalShellOption = {
  id: string;
  label: string;
  command: string;
};

export type TerminalShellOptions = {
  options: TerminalShellOption[];
  defaultShell: string;
};

export type TerminalEvent = {
  kind: string;
  sessionId: string;
  projectPathKey: string;
  session: TerminalSession;
  data?: string;
  outputStartOffset?: number;
  outputEndOffset?: number;
};

export type TerminalClient = {
  shellOptions(): Promise<TerminalShellOptions>;
  list(projectPathKey?: string): Promise<TerminalSession[]>;
  create(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot>;
  createSsh(params: {
    cwd: string;
    projectPathKey: string;
    hostId: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSshCreateResult>;
  answerSshPrompt(params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }): Promise<TerminalSshCreateResult>;
  cancelSshPrompt(promptId: string): Promise<void>;
  sshLatency(sessionId: string, projectPathKey?: string): Promise<TerminalSshLatency>;
  snapshot(
    sessionId: string,
    maxBytes?: number,
    projectPathKey?: string,
  ): Promise<TerminalSnapshot>;
  input(sessionId: string, data: string, projectPathKey?: string): Promise<void>;
  resize(
    sessionId: string,
    cols: number,
    rows: number,
    projectPathKey?: string,
  ): Promise<void>;
  rename(sessionId: string, title: string, projectPathKey?: string): Promise<TerminalSession>;
  close(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  closeProject(projectPathKey: string): Promise<TerminalSession[]>;
  detach(sessionId: string, projectPathKey?: string): Promise<void>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
};
