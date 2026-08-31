// Minimal WebMCP typings for the imperative API surface both Chrome and the
// ChatGPT built-in browser support (docs/research/webmcp-runtime-facts.md).
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface RegisterToolOptions {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface ModelContext {
  registerTool(options: RegisterToolOptions): Promise<void>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

/** Feature-detect exactly as OpenAI's doc does; ignore navigator.modelContext. */
export function webmcpAvailable(): boolean {
  return typeof document.modelContext?.registerTool === "function";
}
