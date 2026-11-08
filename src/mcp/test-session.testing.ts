import assert from "node:assert/strict";
import { RESULT_JSON_LABEL } from "./server.ts";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import type { JsonSchemaType, McpServer } from "@modelcontextprotocol/server";

export interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

/** Decode the single successful content block into its presentation and result fields. */
export function resultFields(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const text = result.content[0]?.text;
  assert.ok(text);
  const at = text.lastIndexOf(`\n${RESULT_JSON_LABEL}`);
  assert.notEqual(at, -1);
  return { text: text.slice(0, at), ...JSON.parse(text.slice(at + 1 + RESULT_JSON_LABEL.length)) };
}

/** The presentation text a reader sees: content without its closing result JSON line. */
export function textOf(result: { content: { text: string }[] }): string {
  const whole = result.content.map((block) => block.text).join("\n");
  const at = whole.lastIndexOf(`\n${RESULT_JSON_LABEL}`);
  return at === -1 ? whole : whole.slice(0, at);
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: JsonSchemaType;
  outputSchema?: JsonSchemaType;
}

/** A raw JSON-RPC client over the in-memory transport: the SDK ships no client in the server package. */
export interface Session {
  /** The `instructions` the server answered `initialize` with. */
  instructions: string | undefined;
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: unknown): Promise<ToolResult>;
  /** Sends the call and returns the request id to cancel, plus the pending result. */
  startCall(name: string, args: unknown): { id: number; result: Promise<ToolResult> };
  cancel(id: number): Promise<void>;
  close(): Promise<void>;
}

export async function openSession(server: McpServer): Promise<Session> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: JSONRPCMessage) => void>();
  let nextId = 1;
  client.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") pending.get(message.id)?.(message);
  };
  await server.connect(serverSide);
  await client.start();
  const request = (method: string, params?: unknown): { id: number; reply: Promise<JSONRPCMessage> } => {
    const id = nextId++;
    const reply = new Promise<JSONRPCMessage>((resolve) => pending.set(id, resolve));
    void client.send({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) } as JSONRPCMessage);
    return { id, reply };
  };
  const initialized = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }).reply;
  const resultOf = async <T>(reply: Promise<JSONRPCMessage>): Promise<T> => {
    const message = (await reply) as { result?: T; error?: unknown };
    if (message.result === undefined) throw new Error(`protocol error: ${JSON.stringify(message.error)}`);
    return message.result;
  };
  const { instructions } = await resultOf<{ instructions?: string }>(initialized);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    instructions,
    listTools: async () => (await resultOf<{ tools: ToolInfo[] }>(request("tools/list").reply)).tools,
    callTool: (name, args) => resultOf<ToolResult>(request("tools/call", { name, arguments: args }).reply),
    startCall: (name, args) => {
      const { id, reply } = request("tools/call", { name, arguments: args });
      return { id, result: resultOf<ToolResult>(reply) };
    },
    cancel: (id) => client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }),
    close: () => client.close(),
  };
}
