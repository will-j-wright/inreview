import { z } from "zod";

export const BRIDGE_PROTOCOL_VERSION = 2;
export const BRIDGE_VERSION = "0.0.1";
export const BRIDGE_MAX_MESSAGE_BYTES = 1024 * 1024;
export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

export const bridgeToolNameSchema = z.enum([
  "connect_workspace",
  "read_review_metadata",
  "read_comments",
  "reply_comment",
  "close_comments",
]);

export type BridgeToolName = z.infer<typeof bridgeToolNameSchema>;

export const bridgeRegistrationSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeVersion: z.string().min(1).max(64),
    instanceId: z.uuid(),
    canonicalWorkspaceRoot: z.string().min(1).max(32_768),
    repositoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    platform: z.enum(["win32", "linux", "darwin"]),
  })
  .strict();

export type BridgeRegistration = z.infer<typeof bridgeRegistrationSchema>;

export const bridgeToolCallSchema = z
  .object({
    sessionId: z.uuid(),
    name: bridgeToolNameSchema,
    arguments: z.unknown(),
  })
  .strict();

export type BridgeToolCall = z.infer<typeof bridgeToolCallSchema>;

export const bridgeCloseSessionSchema = z
  .object({
    sessionId: z.uuid(),
  })
  .strict();

export const bridgeRegisterResultSchema = z
  .object({
    registrationId: z.uuid(),
  })
  .strict();

export const bridgeWireRequestSchema = z
  .object({
    type: z.literal("request"),
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(128),
    params: z.unknown(),
  })
  .strict();

export const bridgeWireResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("response"),
      id: z.string().min(1).max(128),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("response"),
      id: z.string().min(1).max(128),
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1).max(128),
          message: z.string().min(1).max(1_024),
        })
        .strict(),
    })
    .strict(),
]);

export const bridgeWireMessageSchema = z.union([
  bridgeWireRequestSchema,
  bridgeWireResponseSchema,
]);

export type BridgeWireRequest = z.infer<typeof bridgeWireRequestSchema>;
export type BridgeWireResponse = z.infer<typeof bridgeWireResponseSchema>;
