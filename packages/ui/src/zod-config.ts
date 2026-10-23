import { z } from 'zod';

// Imported first, before any schema exists: the CSP has no 'unsafe-eval', so
// Zod must not probe for eval (the probe itself is a CSP violation).
z.config({ jitless: true });
