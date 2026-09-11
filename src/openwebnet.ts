import net from 'node:net';

export interface OpenWebNetOptions {
  host: string;
  port: number;
  monitoredLights?: readonly string[];
  reconnectDelayMs?: number;
  commandTimeoutMs?: number;
  keepAliveIntervalMs?: number;
}

export interface OpenWebNetEvents {
  onLightState?: (where: string, on: boolean) => void;
  onDimmerState?: (where: string, brightness: number) => void;
}

type SessionType = 'COMMAND' | 'MONITOR';
type Log = (message: string) => void;

interface PendingCommand {
  frame: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const ACK = '*#*1##';
const NACK = '*#*0##';
const DIMMER_LEVELS = [0, 100, 1, 10, 20, 30, 40, 50, 60, 75, 100] as const;

class OpenWebNetConnection {
  private socket?: net.Socket;
  private buffer = '';
  private ready = false;
  private sessionRequested = false;
  private stopped = true;
  private reconnectTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;
  private commandTimer?: NodeJS.Timeout;
  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private activeCommand?: PendingCommand;
  private readonly commandQueue: PendingCommand[] = [];

  constructor(
    private readonly type: SessionType,
    private readonly options: Required<Pick<
      OpenWebNetOptions,
      'host' | 'port' | 'reconnectDelayMs' | 'commandTimeoutMs' | 'keepAliveIntervalMs'
    >>,
    private readonly log: Log,
    private readonly onFrame: (frame: string) => void,
    private readonly onReady?: () => void,
  ) {}

  public start(): Promise<void> {
    this.stopped = false;

    if (!this.socket || this.socket.destroyed) {
      this.connect();
    }

    return this.waitUntilReady();
  }

  public waitUntilReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }

    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
    }

    return this.readyPromise;
  }

  public send(frame: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.commandQueue.push({ frame, resolve, reject });
      this.processCommandQueue();
    });
  }

  public sendWithoutAck(frame: string): void {
    if (!this.ready) {
      return;
    }

    this.write(frame);
  }

  public stop(): void {
    this.stopped = true;
    this.ready = false;

    this.clearTimers();
    this.rejectCommands(new Error(`Sessão ${this.type} encerrada.`));
    this.failReady(new Error(`Sessão ${this.type} encerrada.`));

    this.socket?.destroy();
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped || (this.socket && !this.socket.destroyed)) {
      return;
    }

    this.ready = false;
    this.sessionRequested = false;
    this.buffer = '';
    this.log(`${this.type}: conectando.`);

    const socket = net.createConnection({
      host: this.options.host,
      port: this.options.port,
    });

    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);
    socket.setNoDelay(true);

    socket.on('data', (data: string) => this.handleData(data));

    socket.on('error', (error: Error) => {
      if (!this.stopped) {
        this.log(`${this.type}: erro de conexão (${error.message}).`);
      }
    });

    socket.on('close', () => this.handleClose());
  }

  private handleData(data: string): void {
    this.buffer += data.trim();

    let frameEnd = this.buffer.indexOf('##');
    while (frameEnd !== -1) {
      const frame = this.buffer.slice(0, frameEnd + 2);
      this.buffer = this.buffer.slice(frameEnd + 2);
      this.handleFrame(frame);
      frameEnd = this.buffer.indexOf('##');
    }
  }

  private handleFrame(frame: string): void {
    if (!this.ready) {
      if (frame !== ACK) {
        this.failReady(new Error(`${this.type}: gateway recusou a abertura da sessão.`));
        this.socket?.destroy();
        return;
      }

      if (!this.sessionRequested) {
        this.sessionRequested = true;
        this.write(this.type === 'COMMAND' ? '*99*0##' : '*99*1##');
        return;
      }

      this.ready = true;
      this.resolveReady?.();
      this.resetReadyPromise();
      this.log(`${this.type}: conectado.`);

      if (this.type === 'COMMAND') {
        this.startKeepAlive();
      }

      this.onReady?.();
      this.processCommandQueue();
      return;
    }

    if (frame !== ACK && frame !== NACK) {
      this.onFrame(frame);
    }
  }

  private processCommandQueue(): void {
    if (this.type !== 'COMMAND' || !this.ready || this.activeCommand) {
      return;
    }

    const next = this.commandQueue.shift();
    if (!next) {
      return;
    }

    this.activeCommand = next;
    this.write(next.frame);

    this.commandTimer = setTimeout(() => {
      this.finishActiveCommand();
    }, 50);
  }

  private finishActiveCommand(): void {
    if (!this.activeCommand) {
      return;
    }

    clearTimeout(this.commandTimer);
    this.commandTimer = undefined;

    const command = this.activeCommand;
    this.activeCommand = undefined;
    command.resolve();
    this.processCommandQueue();
  }

  private failActiveCommand(error: Error): void {
    if (!this.activeCommand) {
      return;
    }

    clearTimeout(this.commandTimer);
    this.commandTimer = undefined;

    const command = this.activeCommand;
    this.activeCommand = undefined;
    command.reject(error);
    this.processCommandQueue();
  }

  private handleClose(): void {
    this.socket = undefined;
    this.ready = false;
    this.sessionRequested = false;
    this.clearTimers();
    this.rejectCommands(new Error(`Conexão ${this.type} perdida.`));

    if (this.stopped) {
      return;
    }

    this.log(
      `${this.type}: desconectado; nova tentativa em ${this.options.reconnectDelayMs / 1_000} segundos.`,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectDelayMs);
  }

  private startKeepAlive(): void {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.ready && !this.activeCommand) {
        this.write('*#13**15##');
      }
    }, this.options.keepAliveIntervalMs);
  }

  private write(frame: string): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(`Sessão ${this.type} não está conectada.`);
    }

    this.socket.write(frame);
  }

  private rejectCommands(error: Error): void {
    this.failActiveCommand(error);

    while (this.commandQueue.length > 0) {
      this.commandQueue.shift()?.reject(error);
    }
  }

  private failReady(error: Error): void {
    this.rejectReady?.(error);
    this.resetReadyPromise();
  }

  private resetReadyPromise(): void {
    this.readyPromise = undefined;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.commandTimer);
    clearInterval(this.keepAliveTimer);
    this.reconnectTimer = undefined;
    this.commandTimer = undefined;
    this.keepAliveTimer = undefined;
  }
}

export class OpenWebNetClient {
  private readonly monitoredLights: ReadonlySet<string>;
  private readonly command: OpenWebNetConnection;
  private readonly monitor: OpenWebNetConnection;
  private readonly dimmerTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(
    options: OpenWebNetOptions,
    private readonly log: Log,
    private readonly events: OpenWebNetEvents = {},
  ) {
    const connectionOptions = {
      host: options.host,
      port: options.port,
      reconnectDelayMs: options.reconnectDelayMs ?? 5_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 3_000,
      keepAliveIntervalMs: options.keepAliveIntervalMs ?? 25_000,
    };

    this.monitoredLights = new Set(options.monitoredLights ?? ['01', '41']);

    this.command = new OpenWebNetConnection(
      'COMMAND',
      connectionOptions,
      this.log,
      (frame) => this.handleBusFrame(frame),
      () => this.requestInitialLightStates(),
    );

    this.monitor = new OpenWebNetConnection(
      'MONITOR',
      connectionOptions,
      this.log,
      (frame) => this.handleBusFrame(frame),
    );
  }

  public async start(): Promise<void> {
    if (this.started) {
      await Promise.all([
        this.command.waitUntilReady(),
        this.monitor.waitUntilReady(),
      ]);
      return;
    }

    this.started = true;
    await Promise.all([
      this.command.start(),
      this.monitor.start(),
    ]);
  }

  public stop(): void {
    this.started = false;
    for (const timer of this.dimmerTimers.values()) {
      clearTimeout(timer);
    }
    this.dimmerTimers.clear();
    this.command.stop();
    this.monitor.stop();
  }

  public async setLight(where: string, on: boolean): Promise<void> {
    if (!this.monitoredLights.has(where)) {
      throw new Error(`Luz ${where} não está configurada para monitoramento.`);
    }

    await this.command.waitUntilReady();
    await this.command.send(`*1*${on ? '1' : '0'}*${where}##`);
  }

  public setDimmer(where: string, brightness: number): void {
    if (!this.monitoredLights.has(where)) {
      throw new Error(`Dimmer ${where} não está configurado para monitoramento.`);
    }

    clearTimeout(this.dimmerTimers.get(where));

    const level = Math.max(0, Math.min(100, Math.round(brightness)));
    const frame = level > 0
      ? `*#1*${where}*#1*${level + 100}*1##`
      : `*1*0*${where}##`;

    const timer = setTimeout(() => {
      this.dimmerTimers.delete(where);
      void this.command.waitUntilReady()
        .then(() => this.command.send(frame))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`Dimmer ${where}: erro ao enviar brilho (${message}).`);
        });
    }, 500);

    this.dimmerTimers.set(where, timer);
  }

  public requestInitialLightStates(): void {
    for (const where of this.monitoredLights) {
      this.command.sendWithoutAck(`*#1*${where}##`);
    }

    this.log(
      `Leitura inicial solicitada para as luzes ${Array.from(this.monitoredLights).join(' e ')}.`,
    );
  }

  // Compatibilidade temporária com o index.ts atual.
  public connect(): Promise<void> {
    return this.start();
  }

  // start() já abre a sessão COMMAND; este método pode ser removido depois.
  public openCommandSession(): Promise<void> {
    return this.command.waitUntilReady();
  }

  // Alias temporário usado pelo index.ts atual.
  public disconnect(): void {
    this.stop();
  }

  private handleBusFrame(frame: string): void {
    const match = frame.match(/^\*1\*(\d+)\*([0-9#]+)##$/);
    if (!match) {
      return;
    }

    const [, rawLevel, where] = match;
    if (!this.monitoredLights.has(where)) {
      return;
    }

    const level = Number(rawLevel);
    if (level === 0 || level === 1) {
      this.events.onLightState?.(where, level === 1);
      return;
    }

    if (level >= 2 && level <= 10) {
      this.events.onDimmerState?.(where, DIMMER_LEVELS[level]);
    }
  }
}
