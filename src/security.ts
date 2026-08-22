import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export type ApiRole = "norium" | "admin";
export type SessionContext = { userId: string; sessionId: string };
type SessionRequest = Request & { whatsappSession?: SessionContext };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEqual(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  return timingSafeEqual(digest(received), digest(expected));
}

function receivedKey(request: Request): string {
  const authorization = request.header("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return (request.header("x-api-key") || "").trim();
}

export function requireRole(role: ApiRole) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const key = receivedKey(request);
    const allowed = role === "admin"
      ? constantTimeEqual(key, config.adminApiKey)
      : constantTimeEqual(key, config.noriumApiKey) || constantTimeEqual(key, config.adminApiKey);
    if (!allowed) {
      response.status(401).json({ error: "unauthorized", message: "Credencial da API invalida." });
      return;
    }
    next();
  };
}

export function requireSessionContext(request: Request, response: Response, next: NextFunction): void {
  const userId = (request.header("x-norium-user-id") || "").trim();
  const sessionId = (request.header("x-norium-session-id") || "").trim();
  const suppliedSignature = (request.header("x-norium-session-signature") || "").trim().toLowerCase();
  if (!userId || userId.length > 180 || /[\r\n\0]/.test(userId) || !/^[a-zA-Z0-9_.-]{3,80}$/.test(sessionId)) {
    response.status(401).json({ error: "invalid_session_context", message: "Contexto privado da sessao ausente ou invalido." });
    return;
  }
  const expectedSignature = createHmac("sha256", config.noriumApiKey)
    .update(`${userId}\n${sessionId}`, "utf8")
    .digest("hex");
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) {
    response.status(401).json({ error: "invalid_session_context", message: "Assinatura da sessao invalida." });
    return;
  }
  (request as SessionRequest).whatsappSession = { userId, sessionId };
  next();
}

export function requestSessionContext(request: Request): SessionContext {
  const context = (request as SessionRequest).whatsappSession;
  if (!context) throw new Error("Contexto da sessao nao foi validado.");
  return context;
}

export function requireDestructiveConfirmation(request: Request, response: Response, next: NextFunction): void {
  if ((request.header("x-confirm-destructive") || "").toLowerCase() !== "true") {
    response.status(428).json({
      error: "confirmation_required",
      message: "Envie X-Confirm-Destructive: true para executar esta operacao.",
    });
    return;
  }
  next();
}
