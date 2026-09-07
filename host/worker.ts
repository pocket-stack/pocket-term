import { dispatchOffload } from "@pocketjs/framework/offload/provider";
declare const self: { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let config: { endpoint: string; token: string };
self.onmessage = async event => {
  if (event.data.init) { config = event.data.init; return; }
  const forward = async (path: string, payload: string) => {
      const response = await fetch(config.endpoint.replace(/\/exchange$/, path), {
        method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Terminal worker: ${await response.text()}`);
      return response.text();
  };
  self.postMessage(await dispatchOffload({
    "term.exchange": payload => forward("/exchange", payload),
    "term.history": payload => forward("/history", payload),
    "term.history.batch": payload => forward("/history-batch", payload),
    "term.input": payload => forward("/input", payload),
  }, event.data));
};
