import { kody } from "kody:runtime";
import { createShipletClient, type Connection } from "./client";

export function client(connection: Connection = {}) {
  return createShipletClient({
    origin: connection.origin ?? "https://shiplet.cc",
    execute: ({ code }) => kody.mcp[connection.server ?? "shiplet"].execute({ code }),
  });
}
