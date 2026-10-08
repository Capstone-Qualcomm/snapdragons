import { createServer } from "node:http";
import { json } from "./core/http.mjs";
import { handleIntegrationRequest } from "./integrations/index.mjs";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const server = createServer((request, response) => {
  void routeRequest(request, response).catch((error) => {
    console.error("Request failed:", error);
    if (!response.headersSent) json(response, 500, { error: "The server could not complete this request." });
    else response.destroy();
  });
});

async function routeRequest(request, response) {
  let url;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    json(response, 400, { error: "Invalid URL." });
    return;
  }

  if (await handleIntegrationRequest(request, response, url)) return;
  json(response, 404, { error: "Not found" });
}

server.listen(port, host, () => {
  console.error(`Continuum API listening at http://${host}:${port}`);
});
