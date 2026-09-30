// OWNER: ROOM agent. WebSocket close codes the Node server uses (shared so the client can tell them apart).

/**
 * The server ended this connection on purpose (ZoneConnection.kick / ClientSink.close): session revoked
 * ("Session ended — please log in again"), same account logged in elsewhere, ... The close reason carries
 * the human-readable message; the client returns to the title / login screen with it instead of treating
 * it as a lost connection.
 */
export const WS_CLOSE_KICKED = 4001;

/**
 * A planned restart (the LAN launcher replacing its server child: setup done, a restore, a port change). The client
 * shows the reason and reconnects on its own (src/client/net/reconnect.ts; RFC 6455 1012 "Service Restart").
 */
export const WS_CLOSE_SERVICE_RESTART = 1012;
/** The close reason of a planned restart (the client shows it; must fit 123 bytes). */
export const RESTART_CLOSE_REASON = 'Server restarting — back in about 20 s';
