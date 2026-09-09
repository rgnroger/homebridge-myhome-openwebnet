import net from 'node:net';
export class OpenWebNetClient {
    options;
    log;
    socket;
    buffer = '';
    waitingForAck;
    constructor(options, log) {
        this.options = options;
        this.log = log;
    }
    connect() {
        return new Promise((resolve, reject) => {
            this.log(`Conectando ao gateway OpenWebNet ${this.options.host}:${this.options.port}...`);
            const socket = net.createConnection({
                host: this.options.host,
                port: this.options.port,
            });
            this.socket = socket;
            socket.setEncoding('utf8');
            socket.on('connect', () => {
                this.log('Conexão TCP OpenWebNet estabelecida.');
                resolve();
            });
            socket.on('data', (data) => {
                this.handleData(data);
            });
            socket.on('error', (error) => {
                this.log(`Erro OpenWebNet: ${error.message}`);
                reject(error);
            });
            socket.on('close', () => {
                this.log('Conexão OpenWebNet encerrada.');
            });
        });
    }
    async openCommandSession() {
        await this.waitForAck();
        this.sendRaw('*99*0##');
        await this.waitForAck();
        this.log('Sessão de comandos OpenWebNet iniciada.');
    }
    async setLight(where, on) {
        const what = on ? '1' : '0';
        const frame = `*1*${what}*${where}##`;
        this.sendRaw(frame);
        await this.waitForAck();
        this.log(`Luz ${where} ${on ? 'ligada' : 'desligada'} com sucesso.`);
    }
    disconnect() {
        if (!this.socket) {
            return;
        }
        this.socket.end();
        this.socket.destroy();
        this.socket = undefined;
    }
    sendRaw(frame) {
        if (!this.socket || this.socket.destroyed) {
            throw new Error('OpenWebNet não está conectado.');
        }
        this.log(`OpenWebNet TX: ${frame}`);
        this.socket.write(frame);
    }
    waitForAck() {
        return new Promise((resolve) => {
            this.waitingForAck = resolve;
        });
    }
    handleData(data) {
        this.buffer += data;
        let frameEnd;
        while ((frameEnd = this.buffer.indexOf('##')) !== -1) {
            const frame = this.buffer.substring(0, frameEnd + 2);
            this.buffer = this.buffer.substring(frameEnd + 2);
            this.log(`OpenWebNet RX: ${frame}`);
            this.handleFrame(frame);
        }
    }
    handleFrame(frame) {
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
