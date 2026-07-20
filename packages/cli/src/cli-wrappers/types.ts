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
}

export type HelpFlag = {
  name: string;
  description: string;
  required: boolean;
  type: string;
};
