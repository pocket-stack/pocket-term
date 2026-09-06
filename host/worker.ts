import { dispatchOffload } from "@pocketjs/framework/offload/provider";
declare const self: { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let config: { endpoint: string; token: string };
self.onmessage = async event => {
  if (event.data.init) { config = event.data.init; return; }
  self.postMessage(await dispatchOffload({
    async "term.exchange"(payload: string) {
      const response = await fetch(config.endpoint, {
        method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Terminal worker: ${await response.text()}`);
      return response.text();
    },
  }, event.data));
};
