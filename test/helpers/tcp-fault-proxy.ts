import { createConnection, createServer, type Socket } from 'node:net';

/** Disposable loopback relay. Only sockets created by this fixture can be cut. */
export class TcpFaultProxy {
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer(client => {
    if (this.blocked) { client.destroy(); return; }
    const upstream = createConnection({ host: this.host, port: this.targetPort });
    this.connections++;
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.on('close', () => { this.sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream);
    upstream.on('data', chunk => {
      if (this.loseReply) { this.cut(); return; }
      if (!client.write(chunk)) upstream.pause();
    });
    client.on('drain', () => upstream.resume());
    upstream.on('end', () => client.end());
  });
  private blocked = false;
  private loseReply = false;
  connections = 0;
  port = 0;

  constructor(private readonly host: string, private readonly targetPort: number) {
    if (!['localhost', '127.0.0.1', '::1'].includes(host) || !Number.isInteger(targetPort)
      || targetPort < 1 || targetPort > 65535) throw new Error('Fault proxies only accept a verified loopback target.');
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener.');
    this.port = address.port;
    return this;
  }

  cut() { this.blocked = true; for (const socket of this.sockets) socket.destroy(); }
  resume() { this.blocked = false; this.loseReply = false; }
  dropNextReply() { this.loseReply = true; }
  async stop() {
    this.cut();
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
