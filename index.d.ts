import type { IncomingMessage, ServerResponse } from "node:http";

export type Path = Array<string | number>;

/** A field selection: a leaf marker (`true`, `1`, `String`, ...), `false`/`null` to skip, or nested fields with optional `args`. */
export type Selection = { args?: Record<string, unknown> } & { [field: string]: unknown };

export type Document = { query: Selection } | { mutation: Selection };

export interface FormattedError {
  message: string;
  path?: Path;
  extensions?: Record<string, unknown>;
}

export interface ExecutionResult<TData = Record<string, unknown>> {
  /** Absent when the request failed validation; `null` when a non-null root field failed. */
  data?: TData | null;
  errors?: FormattedError[];
}

export interface ResolveInfo {
  fieldName: string;
  /** "Query", "Mutation", a schema type name, or null for untyped (schemaless) nested fields. */
  parentType: string | null;
  returnType: string | null;
  operation: "query" | "mutation";
  path: Path;
}

export type Resolver<TContext = any> = (
  parent: any,
  args: Record<string, any>,
  context: TContext,
  info: ResolveInfo
) => unknown;

export type Resolvers<TContext = any> = Record<string, Record<string, Resolver<TContext>>>;

/** A type string such as "String", "Product!", "[Tag!]!". Built-in scalars: String, Int, Float, Boolean, ID, JSON. */
export type TypeRef = string;
export type ArgDefinition = TypeRef | { type: TypeRef; default?: unknown };
export type FieldDefinition = TypeRef | { type: TypeRef; args?: Record<string, ArgDefinition>; description?: string };
export type SchemaDefinition = Record<string, Record<string, FieldDefinition>>;

/** A schema normalized by `buildSchema`. Treat as opaque. */
export interface BuiltSchema {
  readonly types: Record<string, unknown>;
}

export interface EngineOptions<TContext = any> {
  schema?: SchemaDefinition | BuiltSchema | null;
  resolvers: Resolvers<TContext>;
  /** Maximum selection nesting depth. Default 15. */
  maxDepth?: number;
  /** Replace messages of errors that are not JsonQLError with "Internal server error". Default false. */
  maskErrors?: boolean;
  /** Called with every unexpected (non-JsonQLError) error, e.g. for logging. */
  onError?: (error: unknown, info: { path?: Path }) => void;
}

export interface Engine<TContext = any> {
  readonly schema: BuiltSchema | null;
  readonly maskErrors: boolean;
  readonly onError?: EngineOptions["onError"];
  /** Never rejects; failures are reported in `errors`. */
  execute<TData = Record<string, unknown>>(document: unknown, context?: TContext): Promise<ExecutionResult<TData>>;
}

export function createJsonQL<TContext = any>(options: EngineOptions<TContext>): Engine<TContext>;

/** One-off execution. Prefer `createJsonQL` so the schema is built once. */
export function jsonql<TContext = any>(
  schema: SchemaDefinition | BuiltSchema | null | undefined,
  resolvers: Resolvers<TContext>,
  document: unknown,
  context?: TContext
): Promise<ExecutionResult>;

export function buildSchema(definition: SchemaDefinition): BuiltSchema;

export interface HandlerOptions<TContext = any> {
  context?: TContext | ((req: IncomingMessage, res: ServerResponse) => TContext | Promise<TContext>);
  /** Maximum request body size in bytes. Default 1 MiB. */
  maxBodySize?: number;
  maskErrors?: boolean;
  onError?: EngineOptions["onError"];
}

export function createHandler<TContext = any>(
  engine: Engine<TContext>,
  options?: HandlerOptions<TContext>
): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void>;

export class JsonQLError extends Error {
  constructor(
    message: string,
    options?: { code?: string; status?: number; extensions?: Record<string, unknown>; path?: Path; cause?: unknown }
  );
  extensions: Record<string, unknown>;
  status?: number;
  path?: Path;
}
