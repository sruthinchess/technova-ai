// Vercel serverless entry point.
//
// The app is a normal Node HTTP server; on Vercel we hand each request straight to
// the same router instead of listening on a port. Without this file Vercel has
// nothing to invoke and the deployment fails with FUNCTION_INVOCATION_FAILED.
import { handle } from "../server.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  return handle(req, res);
}
