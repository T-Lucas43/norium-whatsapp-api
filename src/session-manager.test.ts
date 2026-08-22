import assert from "node:assert/strict";
import test from "node:test";
import { BlobPersistence } from "./persistence.js";
import { WhatsAppSessionManager } from "./session-manager.js";
import { WebhookDispatcher } from "./webhook.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

test("a session id cannot be reused by another Norium user", async () => {
  const manager = new WhatsAppSessionManager(new WebhookDispatcher(), new BlobPersistence(), logger);
  await manager.logout({ userId: "user-a", sessionId: "wa_user_a" });

  await assert.rejects(
    manager.logout({ userId: "user-b", sessionId: "wa_user_a" }),
    /outro usuario/i,
  );

  await manager.logout({ userId: "user-b", sessionId: "wa_user_b" });
  assert.equal(manager.health().total, 2);
  await manager.shutdown();
});
