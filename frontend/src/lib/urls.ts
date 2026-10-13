const base = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

export function appPath(path: string): string {
  return `${base}${path.replace(/^\//, "")}`;
}

export function apiPath(path: string): string {
  return appPath(path);
}
