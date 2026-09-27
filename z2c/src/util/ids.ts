import { randomBytes, randomUUID } from "node:crypto";

export function newTaskId(): string {
  return `z2c_${randomBytes(9).toString("hex")}`;
}

export function newOutputId(): string {
  return `z2co_${randomBytes(8).toString("hex")}`;
}

export function newRequestId(): string {
  return randomUUID();
}
