import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export type ApiRole = "norium" | "admin";

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
