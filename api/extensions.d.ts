import type { IncomingMessage, ServerResponse } from 'node:http';
declare function extensions(req: IncomingMessage, res: ServerResponse): Promise<void>;
export = extensions;
