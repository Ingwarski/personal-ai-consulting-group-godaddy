// Explicit operator command. Never called by normal startup or a public route.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGoDaddyMatrixConfiguration } from "../src/godaddy/matrix-service-config.ts";
import { inspectMySqlMatrixRelease } from "../src/godaddy/matrix-release-install.ts";
import { MATRIX_RELEASE_PIN } from "../src/godaddy/matrix-release-pin.ts";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const [operation,...options]=process.argv.slice(2);
const commands={schema:"--provision-mysql-schema",import:"--import-mysql",activate:"--activate-mysql"};
let spool;
try {
  if (!Object.hasOwn(commands,operation ?? "")) throw Error("invalid_operation");
  if (operation==="schema" && options.length!==0) throw Error("invalid_options");
  if (operation!=="schema" && (options.length!==4 || options[0]!=="--source-store" || options[2]!=="--source-media"
      || !isAbsolute(options[1]) || !isAbsolute(options[3]))) throw Error("invalid_options");
  const config=parseGoDaddyMatrixConfiguration(process.env);
  if (!config.ok || config.value.storeBackend!=="mysql" || MATRIX_RELEASE_PIN===undefined) throw Error("configuration_unavailable");
  const release=await inspectMySqlMatrixRelease(root,MATRIX_RELEASE_PIN);
  if (!release.ok || release.value.sidecarSha256!==config.value.expectedSha256 || release.value.sidecarPath!==config.value.binaryPath) throw Error("release_unavailable");
  spool=await mkdtemp(join(tmpdir(),"pc-matrix-migrate-"));
  const result=await new Promise((resolveResult,reject)=>{
    const child=spawn(release.value.setupPath,[commands[operation],"--application-root",root,...options],{
      cwd:root,shell:false,stdio:["ignore","pipe","pipe"],env:{...config.value.spawnEnvironment,MATRIX_MEDIA_SPOOL_DIR:spool,TMPDIR:tmpdir()}
    });
    let text="";let size=0;let failed=false;let killTimer;
    const terminate=()=>{failed=true;child.kill("SIGTERM");killTimer ??= setTimeout(()=>child.kill("SIGKILL"),5000);};
    const deadline=setTimeout(terminate,30*60*1000);
    child.stdout.on("data",chunk=>{size+=chunk.length;if(size>4096){terminate();return;}text+=chunk.toString("utf8");});
    // Raw child errors may contain remote diagnostics; never print them.
    child.stderr.resume();child.once("error",()=>{failed=true;});
    // Wait for pipe closure, including failed spawn, before removing owned spool.
    child.once("close",code=>{clearTimeout(deadline);clearTimeout(killTimer);
      code===0 && !failed ? resolveResult(text) : reject(Error("migration_failed"));});
  });
  const value=JSON.parse(result);
  if (!["schema_provisioned","candidate_verified","activated"].includes(value.migration) || Object.keys(value).length!==1) throw Error("invalid_result");
  console.log(JSON.stringify(value));
} catch {
  console.error("Matrix MySQL operation could not be confirmed. Do not reset identity or roll back to SQLite. Check migration status, the pinned release, explicit Published configuration, and source before retrying.");
  process.exitCode=1;
} finally {
  if(spool!==undefined) await rm(spool,{recursive:true,force:true});
}
