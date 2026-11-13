import type { IncomingMessage, ServerResponse } from 'node:http';
declare function youtube(req: IncomingMessage, res: ServerResponse): Promise<void>;
export = youtube;
