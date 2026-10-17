import { createServer } from 'node:http';
import type { FakeRegistry } from './fake.ts';

/** Serves the fake registry over HTTP for a real npm to talk to. */
export async function serveRegistry(
	registry: FakeRegistry,
): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer((incoming, outgoing) => {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (typeof value === 'string') {
				headers[name] = value;
			}
		}
		incoming.resume();
		const response = registry.fetch(incoming.method ?? 'GET', incoming.url ?? '/', headers);
		outgoing.writeHead(response.status, {
			'content-type': response.type,
			'content-length': response.body.length,
		});
		outgoing.end(response.body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	registry.url = `http://127.0.0.1:${port}`;
	return {
		url: registry.url,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
