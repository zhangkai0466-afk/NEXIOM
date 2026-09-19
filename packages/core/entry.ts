import { CoreService } from "./service";

type Packet = {
  id: string;
  command?: unknown;
  openPath?: string;
  openName?: string;
  runtimeSecrets?: Record<string, string>;
  shutdown?: boolean;
};
type ParentPort = {
  postMessage(value: unknown): void;
  on(event: string, listener: (message: { data: Packet }) => void): void;
};
const parentPort = (process as typeof process & { parentPort?: ParentPort })
  .parentPort;
const send = (value: unknown) =>
  parentPort ? parentPort.postMessage(value) : process.send?.(value);
const dataDir = process.argv[2];
if (!dataDir) throw new Error("Missing core data directory");
const service = new CoreService(dataDir, () => send({ type: "changed" }));
const receive = async (packet: Packet) => {
  try {
    if (packet.shutdown) {
      await service.close();
      send({ id: packet.id, result: {} });
      process.exit();
    }
    if (packet.runtimeSecrets !== undefined) {
      service.setRuntimeSecrets(packet.runtimeSecrets);
      send({ id: packet.id, result: {} });
      return;
    }
    const result = packet.openPath
      ? await service.openProject(packet.openPath, packet.openName)
      : await service.request(packet.command);
    send({ id: packet.id, result });
  } catch (error) {
    send({
      id: packet.id,
      error: error instanceof Error ? error.message : "核心请求失败。",
    });
  }
};
if (parentPort) {
  parentPort.on("message", (message) => void receive(message.data));
  send({ type: "ready" });
} else {
  process.on("message", (packet) => void receive(packet as Packet));
  send({ type: "ready" });
}
process.on(
  "disconnect",
  () => void service.close().finally(() => process.exit()),
);
