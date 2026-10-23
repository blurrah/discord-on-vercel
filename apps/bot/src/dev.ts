// Local development server. On Vercel, `src/index.ts` is deployed directly.
import { serve } from '@hono/node-server';
import app from './index';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`Bot listening on http://localhost:${port}`));
