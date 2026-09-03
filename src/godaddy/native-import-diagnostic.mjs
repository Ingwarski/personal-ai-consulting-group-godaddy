import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PACKAGE_NAME = "@matrix-org/matrix-sdk-crypto-nodejs";

const sanitizeMessage = (error) => String(error?.message ?? error ?? "unknown error")
  .replaceAll(process.cwd(), "<application>")
  .replace(/\/[^\n]*?node_modules\//g, "<node_modules>/");

const classifyFailure = (error) => {
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = sanitizeMessage(error);
  if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(message)) {
    return { kind: "module_or_native_binary_missing", code, message };
  }
  if (code === "ERR_DLOPEN_FAILED" || /ELF|GLIBC|NODE_MODULE_VERSION|invalid ELF/.test(message)) {
    return { kind: "native_binary_incompatible", code, message };
  }
  return { kind: "native_import_failed", code, message };
};

/**
 * One-time Preview-only diagnostic. It performs no Matrix operation and returns
 * only the package-loader outcome needed to identify why the native binding is
 * unavailable. The server route that calls this function is removed after use.
 */
export async function diagnoseMatrixNativeImport({
  resolvePackage = () => require.resolve(`${PACKAGE_NAME}/package.json`),
  loadModule = () => import(PACKAGE_NAME)
} = {}) {
  let packageInstalled = true;
  try {
    resolvePackage();
  } catch {
    packageInstalled = false;
  }

  try {
    await loadModule();
    return {
      ok: true,
      packageInstalled,
      nativeBinding: "loaded",
      node: process.version,
      platform: process.platform,
      architecture: process.arch
    };
  } catch (error) {
    return {
      ok: true,
      packageInstalled,
      nativeBinding: "unavailable",
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      failure: classifyFailure(error)
    };
  }
}
