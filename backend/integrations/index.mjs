import { handleJiraRequest } from "./jira/routes.mjs";

const integrationRouters = [handleJiraRequest];

export async function handleIntegrationRequest(request, response, url) {
  for (const route of integrationRouters) {
    if (await route(request, response, url)) return true;
  }
  return false;
}
