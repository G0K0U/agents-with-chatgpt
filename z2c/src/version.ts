/**
 * Z2C's own stable semantic protocol version. This is the PUBLIC contract of
 * the Z2C control surface (MCP tool names, management API, sanitized response
 * shapes) and is deliberately decoupled from the ZCode runtime version
 * (provider.providerVersion): ZCode may change internally while this contract
 * stays stable. Additive evolution only; breaking changes bump the major.
 */
export const Z2C_PROTOCOL_VERSION = 1;

export const Z2C_SERVICE_NAME = "z2c-service";
