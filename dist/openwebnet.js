import net from 'node:net';
const ACK = '*#*1##';
const NACK = '*#*0##';
class OpenWebNetConnection {
    type;
    options;
    log;
    onFrame;
    onReady;
    socket;
    buffer = '';
    ready = false;
    sessionRequested = false;
    stopped = true;
    reconnectTimer;
    keepAliveTimer;
    commandTimer;
    readyPromise;
    resolveReady;
    rejectReady;
    activeCommand;
    commandQueue = [];
    constructor(type, options, log, onFrame, onReady) {
        this.type = type;
        this.options = options;
        this.log = log;
        this.onFrame = onFrame;
        this.onReady = onReady;
    }
    start() {
        this.stopped = false;
        if (!this.socket || this.socket.destroyed) {
            this.connect();
        }
        return this.waitUntilReady();
    }
    waitUntilReady() {
        if (this.ready) {
            return Promise.resolve();
        }
        if (!this.readyPromise) {
            this.readyPromise = new Promise((resolve, reject) => {
                this.resolveReady = resolve;
                this.rejectReady = reject;
            });
        }
        return this.readyPromise;
    }
    send(frame) {
        return new Promise((resolve, reject) => {
            this.commandQueue.push({ frame, resolve, reject });
            this.processCommandQueue();
        });
    }
    sendWithoutAck(frame) {
        if (!this.ready) {
            return;
        }
        this.write(frame);
    }
    stop() {
        this.stopped = true;
        this.ready = false;
        this.clearTimers();
        this.rejectCommands(new Error(`Sessão ${this.type} encerrada.`));
        this.failReady(new Error(`Sessão ${this.type} encerrada.`));
        this.socket?.destroy();
        this.socket = undefined;
    }
    connect() {
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
        socket.on('data', (data) => this.handleData(data));
        socket.on('error', (error) => {
            if (!this.stopped) {
                this.log(`${this.type}: erro de conexão (${error.message}).`);
            }
        });
        socket.on('close', () => this.handleClose());
    }
    handleData(data) {
        this.buffer += data.trim();
        let frameEnd = this.buffer.indexOf('##');
        while (frameEnd !== -1) {
            const frame = this.buffer.slice(0, frameEnd + 2);
            this.buffer = this.buffer.slice(frameEnd + 2);
            this.handleFrame(frame);
            frameEnd = this.buffer.indexOf('##');
        }
    }
    handleFrame(frame) {
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
    processCommandQueue() {
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
    finishActiveCommand() {
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
    failActiveCommand(error) {
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
    handleClose() {
        this.socket = undefined;
        this.ready = false;
        this.sessionRequested = false;
        this.clearTimers();
        this.rejectCommands(new Error(`Conexão ${this.type} perdida.`));
        if (this.stopped) {
            return;
        }
        this.log(`${this.type}: desconectado; nova tentativa em ${this.options.reconnectDelayMs / 1_000} segundos.`);
        this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectDelayMs);
    }
    startKeepAlive() {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = setInterval(() => {
            if (this.ready && !this.activeCommand) {
                this.write('*#13**15##');
            }
        }, this.options.keepAliveIntervalMs);
    }
    write(frame) {
        if (!this.socket || this.socket.destroyed) {
            throw new Error(`Sessão ${this.type} não está conectada.`);
        }
        this.socket.write(frame);
    }
    rejectCommands(error) {
        this.failActiveCommand(error);
        while (this.commandQueue.length > 0) {
            this.commandQueue.shift()?.reject(error);
        }
    }
    failReady(error) {
        this.rejectReady?.(error);
        this.resetReadyPromise();
    }
    resetReadyPromise() {
        this.readyPromise = undefined;
        this.resolveReady = undefined;
        this.rejectReady = undefined;
    }
    clearTimers() {
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.commandTimer);
        clearInterval(this.keepAliveTimer);
        this.reconnectTimer = undefined;
        this.commandTimer = undefined;
        this.keepAliveTimer = undefined;
    }
}
export class OpenWebNetClient {
    log;
    events;
    monitoredLights;
    command;
    monitor;
    started = false;
    constructor(options, log, events = {}) {
        this.log = log;
        this.events = events;
        const connectionOptions = {
            host: options.host,
            port: options.port,
            reconnectDelayMs: options.reconnectDelayMs ?? 5_000,
            commandTimeoutMs: options.commandTimeoutMs ?? 3_000,
            keepAliveIntervalMs: options.keepAliveIntervalMs ?? 25_000,
        };
        this.monitoredLights = new Set(options.monitoredLights ?? ['01', '41']);
        this.command = new OpenWebNetConnection('COMMAND', connectionOptions, this.log, (frame) => this.handleBusFrame(frame), () => this.requestInitialLightStates());
        this.monitor = new OpenWebNetConnection('MONITOR', connectionOptions, this.log, (frame) => this.handleBusFrame(frame));
    }
    async start() {
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
    stop() {
        this.started = false;
        this.command.stop();
        this.monitor.stop();
    }
    async setLight(where, on) {
        if (!this.monitoredLights.has(where)) {
            throw new Error(`Luz ${where} não está configurada para monitoramento.`);
        }
        await this.command.waitUntilReady();
        await this.command.send(`*1*${on ? '1' : '0'}*${where}##`);
        this.log(`Luz ${where}: comando ${on ? 'ON' : 'OFF'} enviado.`);
    }
    requestInitialLightStates() {
        for (const where of this.monitoredLights) {
            this.command.sendWithoutAck(`*#1*${where}##`);
        }
        this.log(`Leitura inicial solicitada para as luzes ${Array.from(this.monitoredLights).join(' e ')}.`);
    }
    // Compatibilidade temporária com o index.ts atual.
    connect() {
        return this.start();
    }
    // start() já abre a sessão COMMAND; este método pode ser removido depois.
    openCommandSession() {
        return this.command.waitUntilReady();
    }
    // Alias temporário usado pelo index.ts atual.
    disconnect() {
        this.stop();
    }
    handleBusFrame(frame) {
        const match = frame.match(/^\*1\*(0|1)\*([0-9#]+)##$/);
        if (!match) {
            return;
        }
        const [, what, where] = match;
        if (!this.monitoredLights.has(where)) {
            return;
        }
        const on = what === '1';
        this.log(`Luz ${where}: ${on ? 'ON' : 'OFF'}.`);
        this.events.onLightState?.(where, on);
    }
}
