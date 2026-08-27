import { config } from 'dotenv'

// Load package-local .env first (if any), then the repo-root .env.
// Existing process.env values are never overridden.
config()
config({ path: new URL('../../../../.env', import.meta.url) })
