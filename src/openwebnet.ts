import net from 'node:net';

export interface OpenWebNetOptions {
  host: string;
  port: number;
  timeout?: number;
}

export class OpenWebNetClient {

  private socket?: net.Socket;
  private buffer = '';
  private waitingForAck?: () => void;

  constructor(
    private readonly options: OpenWebNetOptions,
    private readonly log: (message: string) => void,
  ) {}

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {

      this.log(
        `Conectando ao gateway OpenWebNet ${this.options.host}:${this.options.port}...`,
      );

      const socket = net.createConnection({
        host: this.options.host,
        port: this.options.port,
      });

      this.socket = socket;

      socket.setEncoding('utf8');
      socket.setTimeout(this.options.timeout ?? 5000);

      socket.on('connect', () => {
        this.log('Conexão TCP OpenWebNet estabelecida.');
        resolve();
      });

      socket.on('data', (data: string) => {
        this.handleData(data);
      });

      socket.on('timeout', () => {
        this.log('Timeout na conexão OpenWebNet.');
        socket.destroy();
      });

      socket.on('error', (error: Error) => {
        this.log(`Erro OpenWebNet: ${error.message}`);
        reject(error);
      });

      socket.on('close', () => {
        this.log('Conexão OpenWebNet encerrada.');
      });
    });
  }

  public async openCommandSession(): Promise<void> {
    await this.waitForAck();

    this.sendRaw('*99*0##');

    await this.waitForAck();

    this.log('Sessão de comandos OpenWebNet iniciada.');
  }

  public async setLight(where: string, on: boolean): Promise<void> {
    const what = on ? '1' : '0';
    const frame = `*1*${what}*${where}##`;

    this.sendRaw(frame);

    await this.waitForAck();

    this.log(
      `Luz ${where} ${on ? 'ligada' : 'desligada'} com sucesso.`,
    );
  }

  public disconnect(): void {
    if (!this.socket) {
      return;
    }

    this.socket.end();
    this.socket.destroy();
    this.socket = undefined;
  }

  private sendRaw(frame: string): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('OpenWebNet não está conectado.');
    }

    this.log(`OpenWebNet TX: ${frame}`);

    this.socket.write(frame);
  }

  private waitForAck(): Promise<void> {
    return new Promise((resolve) => {
      this.waitingForAck = resolve;
    });
  }

  private handleData(data: string): void {
    this.buffer += data;

    let frameEnd: number;

    while ((frameEnd = this.buffer.indexOf('##')) !== -1) {

      const frame = this.buffer.substring(0, frameEnd + 2);

      this.buffer = this.buffer.substring(frameEnd + 2);

      this.log(`OpenWebNet RX: ${frame}`);

      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: string): void {

    if (frame === '*#*1##') {
      this.log('OpenWebNet: ACK recebido.');

      if (this.waitingForAck) {
        const resolve = this.waitingForAck;
        this.waitingForAck = undefined;
        resolve();
      }

      return;
    }

    if (frame === '*#*0##') {
      this.log('OpenWebNet: NACK recebido.');
      return;
    }

    this.log(`OpenWebNet: frame recebido: ${frame}`);
  }
}