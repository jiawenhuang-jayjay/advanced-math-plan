export function onRequest({ request, env }) {
  return env.PROGRESS_API.fetch(request);
}
