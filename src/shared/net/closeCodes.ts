// OWNER: ROOM agent. WebSocket close codes the Node server uses (shared so the client can tell them apart).

/**
 * The server ended this connection on purpose (ZoneConnection.kick / ClientSink.close): session revoked
 * ("Session ended — please log in again"), same account logged in elsewhere, ... The close reason carries
 * the human-readable message; the client returns to the title / login screen with it instead of treating
 * it as a lost connection.
 */
export const WS_CLOSE_KICKED = 4001;
