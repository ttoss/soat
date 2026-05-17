export type ParsedFlags = {
  single: Record<string, string>;
  repeated: Record<string, string[]>;
};

export type RouteLike = {
  serviceClass: string;
  operationId: string;
  description: string;
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
  apply(args: { context: WrapperContext }): WrapperResult;
}
