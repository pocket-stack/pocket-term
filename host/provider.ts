import { connectOffloadProvider } from "@pocketjs/framework/offload/provider";
const config = JSON.parse(process.env.POCKET_TERM_PROVIDER!);
const provider = connectOffloadProvider({
  address: config.address, port: config.port, key: config.key, worker: new URL("./worker.ts", import.meta.url),
  data: { endpoint: config.endpoint, token: config.token }, log: console.log,
});
process.on("SIGTERM", () => { provider.close(); process.exit(0); });
