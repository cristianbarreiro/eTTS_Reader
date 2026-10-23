export function requestTabsPermissionFromClick(context, permissionsApi) {
  if (context?.tabsPermissionGranted || typeof permissionsApi?.request !== "function") return null;
  try { return permissionsApi.request({ permissions: ["tabs"] }); }
  catch { return Promise.resolve(false); }
}

export function requestSitePermissionFromClick(context, permissionsApi) {
  const hostPattern = context?.hostPattern;
  if (!context?.url || context.sitePermissionGranted || !hostPattern || typeof permissionsApi?.request !== "function") return null;
  try { return permissionsApi.request({ origins: [hostPattern] }); }
  catch { return Promise.resolve(false); }
}
