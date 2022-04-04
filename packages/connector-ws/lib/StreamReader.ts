import { Deserializer, EventStream, Handler, IFragmentInfo, IMember, IMetadata, IRecord, LDESStreamReader, LDESStreamType, LDESStreamWriter, SimpleStream, Stream, StreamReader, StreamType } from "@connectors/types";
import { Event, RawData, WebSocket, WebSocketServer } from 'ws';


type WsInstance<T> = {
    ws: WebSocket,
    alive: boolean,
    current?: keyof T,
}

class WSServer<T> {
    private readonly handlers: { [K in keyof T]?: Handler<T[K]>[] } = {};
    private readonly deserializers: Deserializer<T>;
    private server: WebSocketServer;
    private clients: WsInstance<T>[] = [];
    private open = false;

    constructor(port: number, deserializers: Deserializer<T>, host = "localhost") {
        this.deserializers = deserializers;
        this.server = new WebSocketServer({ port, host });
        this.server.on("error", (e) => {
            console.error("Ws server error:")
            console.error(e);
        });
        this.server.on("listening", () => this.open = true);
        this.server.on("connection", (ws) => {
            const instance = this.setupWs(ws);
            this.clients.push(instance)
        });

        const interval = setInterval(() => {
            this.clients = this.clients.flatMap(instance => {
                if (!instance.alive) {
                    instance.ws.terminate();
                    return [];
                }

                instance.ws.ping();
                instance.alive = false;
                return [instance];
            });
        }, 30000);

        this.server.on("close", () => clearInterval(interval))
    }

    connected(): Promise<boolean> {
        return new Promise((res) => {
            if (this.open) {
                res(true);
            } else {
                this.server.on("listening", () => res(true));
            }
        })
    }

    private setupWs(ws: WebSocket): WsInstance<T> {
        const instance: WsInstance<T> = { ws, alive: true };

        ws.on("message", (msg: RawData, isBinary: boolean) => {
            if (isBinary && instance.current) {
                const item = this.deserializers[instance.current](<any>msg);
                this.broadcast(instance.current, item);
            } else {
                instance.current = <keyof T>msg.toString();
            }
        });

        ws.on("pong", () => instance.alive = true);
        return instance;
    }

    private broadcast<K extends keyof T>(key: K, item: T[K]) {
        const handlers: Handler<T[K]>[] = this.handlers[key] || [];
        for (const handler of handlers) {
            handler(item);
        }
    }

    on<K extends keyof T>(key: K, handler: (item: T[K]) => Promise<void>) {
        const handlers = this.handlers[key] || (this.handlers[key] = []);
        handlers?.push(handler);
    }

    close() {
        this.server.close();
    }
}

export class WSStreamReader extends WSServer<StreamType> implements StreamReader {
    private readonly dataStream: SimpleStream<IRecord> = new SimpleStream();
    private readonly metadataStream: SimpleStream<IMetadata> = new SimpleStream();
    private current?: IRecord;
    private currentMeta?: IMetadata;

    constructor(port: number, deserializers: Deserializer<StreamType>) {
        super(port, deserializers);
        this.dataStream.on("data", async (r: IRecord) => { this.current = r; })
        this.metadataStream.on("data", async (r: IMetadata) => { this.currentMeta = r; })

        super.on("data", async (i) => this.dataStream.push(i))
        super.on("metadata", async (i) => this.metadataStream.push(i))
    }

    getStream(): Stream<IRecord> {
        return this.dataStream;
    }

    getCurrent(): IRecord | undefined {
        return this.current;
    }

    getMetadataStream(): Stream<IMetadata> {
        return this.metadataStream;
    }

    getCurrentMetadata(): IMetadata | undefined {
        return this.currentMeta;
    }
}

export class WSLDESStreamReader extends WSServer<LDESStreamType> implements LDESStreamReader {
    private readonly dataStream: SimpleStream<IMember> = new SimpleStream();
    private readonly metadataStream: SimpleStream<EventStream> = new SimpleStream();
    private readonly fragmentStream: SimpleStream<IFragmentInfo> = new SimpleStream();
    private current?: IMember;
    private currentMeta?: EventStream;

    constructor(port: number, deserializers: Deserializer<LDESStreamType>) {
        super(port, deserializers);
        this.dataStream.on("data", async (r: IMember) => { this.current = r; })
        this.metadataStream.on("data", async (r: EventStream) => { this.currentMeta = r; })

        super.on("data", async (i) => this.dataStream.push(i));
        super.on("metadata", async (i) => this.metadataStream.push(i));
        super.on("fragment", async (i) => this.fragmentStream.push(i));
    }

    getFragmentsStream(): Stream<IFragmentInfo> {
        return this.fragmentStream;
    }

    getStream(): Stream<IMember> {
        return this.dataStream;
    }

    getCurrent(): IMember | undefined {
        return this.current;
    }

    getMetadataStream(): Stream<EventStream> {
        return this.metadataStream;
    }

    getCurrentMetadata(): EventStream | undefined {
        return this.currentMeta;
    }

}