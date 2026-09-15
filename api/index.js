// The file the host loads. Everything real is in src/http/serverless.ts, which
// is typechecked and tested with the rest of the project; this is compiled
// output so the bundler never has to resolve TypeScript.
export { default } from '../dist/http/serverless.js';
