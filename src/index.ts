import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { bindServerRef } from './utils/server-ref.js';
import { logger } from './utils/logger.js';

const server = createServer();
// stdio is single-session for the whole process — no concurrent tenants to
// isolate from each other, so enterWith's process-lifetime binding is safe.
bindServerRef(server);
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('Alternative Payments MCP server started (stdio)');
