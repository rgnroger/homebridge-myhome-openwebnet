import net from 'node:net';
const ACK = '*#*1##';
const NACK = '*#*0##';
const DIMMER_LEVELS = [0, 100, 1, 10, 20, 30, 40, 50, 60, 75, 100];
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
    monitoredBlinds;
    monitoredAdvancedBlinds;
    command;
    monitor;
    dimmerTimers = new Map();
    blindTimers = new Map();
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
        this.monitoredBlinds = new Set(options.monitoredBlinds ?? []);
        this.monitoredAdvancedBlinds = new Set(options.monitoredAdvancedBlinds ?? []);
        this.command = new OpenWebNetConnection('COMMAND', connectionOptions, this.log, (frame) => this.handleBusFrame(frame), () => this.requestInitialStates());
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
        for (const timer of this.dimmerTimers.values()) {
            clearTimeout(timer);
        }
        this.dimmerTimers.clear();
        for (const timer of this.blindTimers.values()) {
            clearTimeout(timer);
        }
        this.blindTimers.clear();
        this.command.stop();
        this.monitor.stop();
    }
    async setLight(where, on) {
        if (!this.monitoredLights.has(where)) {
            throw new Error(`Luz ${where} não está configurada para monitoramento.`);
        }
        await this.command.waitUntilReady();
        await this.command.send(`*1*${on ? '1' : '0'}*${where}##`);
    }
    setDimmer(where, brightness) {
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
                .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.log(`Dimmer ${where}: erro ao enviar brilho (${message}).`);
            });
        }, 500);
        this.dimmerTimers.set(where, timer);
    }
    setBlind(where, direction) {
        if (!this.monitoredBlinds.has(where)) {
            throw new Error(`Persiana ${where} não está configurada para monitoramento.`);
        }
        clearTimeout(this.blindTimers.get(where));
        this.blindTimers.delete(where);
        const send = (frame) => {
            void this.command.waitUntilReady()
                .then(() => this.command.send(frame))
                .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.log(`Persiana ${where}: erro ao enviar comando (${message}).`);
            });
        };
        send(`*2*0*${where}##`);
        if (direction === 0) {
            return;
        }
        const timer = setTimeout(() => {
            this.blindTimers.delete(where);
            send(`*2*${direction}*${where}##`);
        }, 500);
        this.blindTimers.set(where, timer);
    }
    setAdvancedBlind(where, position) {
        if (!this.monitoredAdvancedBlinds.has(where)) {
            throw new Error(`Persiana avançada ${where} não está configurada para monitoramento.`);
        }
        const target = Math.max(0, Math.min(100, Math.round(position)));
        void this.command.waitUntilReady()
            .then(() => this.command.send(`*#2*${where}*#11#1*${target}##`))
            .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Persiana avançada ${where}: erro ao enviar posição (${message}).`);
        });
    }
    requestInitialStates() {
        const lightingBusQueries = new Set();
        for (const where of this.monitoredLights) {
            const busMarker = '#4#';
            const busMarkerIndex = where.indexOf(busMarker);
            const query = busMarkerIndex === -1
                ? '*#1*0##'
                : `*#1*0#4#${where.slice(busMarkerIndex + busMarker.length)}##`;
            lightingBusQueries.add(query);
        }
        for (const query of lightingBusQueries) {
            void this.command.send(query).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.log(`Erro na leitura inicial das luzes (${message}).`);
            });
        }
        for (const where of this.monitoredAdvancedBlinds) {
            void this.command.send(`*#2*${where}*10##`).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.log(`Persiana avançada ${where}: erro na leitura inicial (${message}).`);
            });
        }
        const total = this.monitoredLights.size + this.monitoredAdvancedBlinds.size;
        if (total > 0) {
            this.log(`Leitura inicial solicitada para ${total} dispositivo(s).`);
        }
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
        const advancedBlindMatch = frame.match(/^\*#2\*([0-9#]+)\*10\*(\d+)\*(\d+)(?:\*\d+){0,2}##$/);
        if (advancedBlindMatch) {
            const [, where, rawDirection, rawPosition] = advancedBlindMatch;
            if (this.monitoredAdvancedBlinds.has(where)) {
                const direction = rawDirection === '11'
                    ? 'UP'
                    : rawDirection === '12'
                        ? 'DOWN'
                        : 'STOP';
                const position = Math.max(0, Math.min(100, Number(rawPosition)));
                this.events.onAdvancedBlindState?.(where, direction, position);
            }
            return;
        }
        const blindMatch = frame.match(/^\*2\*([012])\*([0-9#]+)##$/);
        if (blindMatch) {
            const [, rawDirection, where] = blindMatch;
            if (this.monitoredBlinds.has(where)) {
                this.events.onBlindState?.(where, Number(rawDirection));
            }
            return;
        }
        const advancedDimmerMatch = frame.match(/^\*#1\*([0-9#]+)\*\d+\*(\d+)\*\d+##$/);
        if (advancedDimmerMatch) {
            const [, where, rawBrightness] = advancedDimmerMatch;
            if (this.monitoredLights.has(where)) {
                const brightness = Math.max(0, Math.min(100, Number(rawBrightness) - 100));
                this.events.onDimmerState?.(where, brightness);
            }
            return;
        }
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
