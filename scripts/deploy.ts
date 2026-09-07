/** Install the offload launcher while ftpd owns the console. */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./paths.ts";
const argv = process.argv.slice(2);
const value = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const address = value("--host"), port = Number(value("--ftp-port") ?? 5000);
if (!address || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Usage: bun run deploy --host <ip> [--ftp-port 5000]");
const binary = resolve(ROOT, "dist/3ds/pocketterm-main.3dsx"), bytes = readFileSync(binary);
if (bytes.includes(Buffer.from("pocketjs-captures"))) throw new Error("Rebuild the production launcher without --capture");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "pocket.json"), "utf8"));
const slot = createHash("sha256").update(manifest.id).digest("hex").slice(0, 16);
if (!bytes.includes(Buffer.from(`offload/${slot}.key`))) throw new Error("Launcher lacks this app's offload key path");
mkdirSync(resolve(ROOT, ".pocket"), { recursive: true });
const key = resolve(ROOT, ".pocket/offload.key");
if (!existsSync(key)) writeFileSync(key, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
chmodSync(key, 0o600);
if (!/^[0-9a-f]{64}$/.test(readFileSync(key, "utf8").trim())) throw new Error("Invalid local offload key");
const program = `import ftplib,hashlib,io,json,pathlib,sys,datetime
ftp=ftplib.FTP(); ftp.connect(sys.argv[1],int(sys.argv[2]),timeout=20); ftp.login()
def mkdir(path):
 try: ftp.mkd(path)
 except ftplib.error_perm as e:
  if not str(e).startswith('550'): raise
def read(path):
 out=io.BytesIO(); ftp.retrbinary('RETR '+path,out.write); return out.getvalue()
def write(path,data):
 ftp.storbinary('STOR '+path,io.BytesIO(data),blocksize=65536)
 assert read(path)==data, 'Readback mismatch: '+path
for path in ['/3DS','/pocketjs','/pocketjs/offload','/pocketjs/runtime','/pocketjs/runtime/native-backups']: mkdir(path)
remote='/3DS/pocketterm-main.3dsx'; backup=None
try: previous=read(remote)
except (ftplib.error_perm,ftplib.error_temp) as e:
 if not str(e).startswith('550') and str(e)!='450 No such file or directory': raise
else:
 backup='/pocketjs/runtime/native-backups/pocketterm-main-'+hashlib.sha256(previous).hexdigest()[:16]+'.3dsx'
 write(backup,previous)
write('/pocketjs/offload/'+sys.argv[5]+'.key',pathlib.Path(sys.argv[4]).read_bytes())
data=pathlib.Path(sys.argv[3]).read_bytes(); write(remote,data)
ftp.quit()
print(json.dumps({'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':sys.argv[1],'port':int(sys.argv[2]),'remote':remote,'backup':backup,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'offloadKeyReadback':True,'readback':'byte-identical','freshHardwareInteraction':'pending'},indent=2))
`;
const result = Bun.spawnSync(["python3", "-c", program, address, String(port), binary, key, slot], { stdout: "pipe", stderr: "pipe" });
if (result.exitCode) throw new Error(result.stderr.toString());
writeFileSync(resolve(ROOT, ".pocket/last-deploy.json"), result.stdout);
console.log(result.stdout.toString());
