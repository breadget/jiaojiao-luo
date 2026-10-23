type UrtorisWebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(input: unknown): unknown;
};

interface Document {
  readonly modelContext?: {
    registerTool(
      tool: UrtorisWebMcpTool,
      options?: { signal?: AbortSignal },
    ): void | Promise<void>;
  };
}
