import { createRelayHandler } from '@discord-on-vercel/relay';
import { Hono } from 'hono';
import { client } from './bot';

const relay = createRelayHandler(client);

const app = new Hono();

app.get('/', (c) => c.text('This bot runs on Vercel. The gateway daemon relays Discord events to /api/gateway.'));

// The gateway daemon calls this route: GET once on startup for the config,
// then POST for every event. Requests are signed, so it's safe to expose.
app.on(['GET', 'POST'], '/api/gateway', (c) => relay(c.req.raw));

export default app;
