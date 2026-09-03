import shipletOpenApi from "../openapi.json";

// The checked-in JSON is also staged for Mint. Importing it here keeps the
// Worker discovery route and the published API reference byte-for-byte aligned.
export const SHIPLET_OPENAPI_SPEC = shipletOpenApi;
