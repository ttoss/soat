export type ParsedFlags = {
  single: Record<string, string>;
  repeated: Record<string, string[]>;
};

export type RouteLike = {
  serviceClass: string;
  operationId: string;
  description: string;
  httpMethod: 'get' | 'post' | 'put' | 'patch' | 'delete';
  pathParams: string[];
  queryParams: string[];
};

export type WrapperResult = {
  flags: ParsedFlags;
  forcedBody: Record<string, unknown>;
};

export type WrapperContext = {
  commandName: string;
  route: RouteLike;
  parsedFlags: ParsedFlags;
};

export interface Wrapper {
  id: string;
  commands: string[];
  helpFlags?: HelpFlag[];
  apply(args: { context: WrapperContext }): WrapperResult;
  /**
   * Classifies a **successful** (2xx) payload that reports its own operation
   * as failed, returning what to print on stderr — the CLI then exits
   * non-zero. Returns null when the payload is fine, which is the default for
   * every command that does not implement this.
   *
   * This exists because an endpoint can legitimately answer 2xx for an
   * operation that ran and failed (a formation deploy reconciles, so a
   * resource failure is state, not a bad request). The exit code is the only
   * thing a shell reads, so without this `update-formation && echo deployed`
   * prints `deployed` for a deploy that deployed nothing (#1028).
   */
  failureMessage?(args: { commandName: string; data: unknown }): string | null;
}

export type HelpFlag = {
  name: string;
  description: string;
  required: boolean;
  type: string;
};
