export function selectExtensionApi<T>(
  production: boolean,
  testApi: T,
): T | undefined {
  return production ? undefined : testApi;
}
